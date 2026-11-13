/**
 * The editor-facing half of the Upgrade action: modal confirmation, the
 * Workspace Trust re-check, npm resolution, and running `npm install` as a
 * visible process through HostPlatform.runProcess. Everything decidable
 * without the editor (argv construction, save-flag/ignore-scripts logic,
 * major-version detection) lives in src/core/upgrade/plan.ts instead: this
 * file only wires that output into the platform.
 *
 * SECURITY: runProcess is given the resolved `node` executable and an
 * argument array starting with `npm-cli.js`, never a shell command string,
 * never `npm`/`npm.cmd` directly, so nothing here ever concatenates a
 * package name, version, path, or setting into text a shell would parse, and
 * nothing here relies on a shebang or a Windows batch-file layer. See
 * npmResolver.ts for why.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import semver from 'semver';

import type { DependencyClassification } from '../core/upgrade/plan.js';
import {
  buildCoordinatedInstallArgs,
  buildInstallArgs,
  buildLockfileReconciliationArgs,
  buildManifestReconciliationArgs,
} from '../core/upgrade/plan.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import type { Disposable, HostPlatform } from './platform/hostPlatform.js';
import { PNPM_NOT_FOUND_MESSAGE, resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import type { PackageManagerInvocation } from './resolverVerifier.js';
import { PendingUpgradeRuns, UpgradeLock, isSuccessfulExitCode } from './upgradeTracker.js';
import type { DependencyTaskState } from './webviewProtocol.js';
import type { VerificationExecutionResult } from './upgradeTransaction.js';
import { buildVerificationScriptArgs } from './verificationPolicy.js';
import type { VerificationScript } from './verificationPolicy.js';

export interface UpgradeRunParams {
  importerId?: string;
  packageName: string;
  currentVersion: string;
  target: string;
  classification: DependencyClassification;
  cwd: string;
  ignoreScripts: boolean;
  packageManager: 'npm' | 'pnpm';
  coordinatedChanges?: readonly {
    packageName: string;
    target: string;
    classification: DependencyClassification;
  }[];
}

export type UpgradeRunOutcome = { ok: true } | { ok: false; status?: 'unknown'; code: string; message: string };

/**
 * Host-owned inputs for reconciling an already-staged package.json. No
 * package/version/classification input is accepted because those values must
 * be validated and written by the host before the returned execution runs.
 */
export interface UpgradeManifestReconciliationParams {
  importerId?: string;
  cwd: string;
  ignoreScripts: boolean;
  packageManager: 'npm' | 'pnpm';
  /** Reconcile only the lockfile. See buildManifestReconciliationArgs. */
  lockfileOnly?: boolean;
  /** The project is a workspace member whose lockfile is at the workspace root. */
  workspaceMember?: boolean;
  /** Task title and scope shown to the user. Default to the cleanup wording. */
  taskTitle?: string;
  taskScope?: string;
}

export type PreparedManifestReconciliation =
  | { ok: false; code: string; message: string }
  | { ok: true; execute(): Promise<UpgradeRunOutcome> };

/**
 * Host-owned inputs for synchronizing node_modules to an exact lockfile that
 * has already been generated and reviewed in an isolated project. The
 * package name and target version deliberately do not appear here: those are
 * represented solely by the staged lockfile bytes.
 */
export interface UpgradeLockfileReconciliationParams {
  cwd: string;
  ignoreScripts: boolean;
  packageManager: 'npm' | 'pnpm';
  /** The project is a workspace member whose lockfile is at the workspace root. */
  workspaceMember?: boolean;
  /** Task title shown to the user. Defaults to the transitive-fix title. */
  taskTitle?: string;
  /** Recovery cannot treat an unexpected resolver exception as a known task refusal. */
  throwOnUnexpectedError?: boolean;
}

export type PreparedLockfileReconciliation =
  | { ok: false; code: string; message: string }
  | { ok: true; execute(): Promise<UpgradeRunOutcome> };

export interface UpgradeVerificationParams {
  packageName: string;
  cwd: string;
  packageManager: 'npm' | 'pnpm';
  scripts: readonly VerificationScript[];
  /** Observed only between scripts. An in-flight task is always allowed to reach a stable boundary. */
  signal?: AbortSignal;
}

/**
 * The first npm that finds the workspace root when run from a member's own
 * folder: npm 8.5.0 shipped @npmcli/config 3.0.0 with that lookup
 * (https://docs.npmjs.com/cli/v8/using-npm/changelog/#v850-2022-02-10).
 * An older npm treats the member as its own project and writes a lockfile
 * beside its package.json, not the one the transaction captured.
 */
export const NPM_WORKSPACE_MEMBER_MIN_VERSION = '8.5.0';
export const NPM_TOO_OLD_FOR_MEMBER_CODE = 'NPM_TOO_OLD_FOR_WORKSPACE';
export const NPM_TOO_OLD_FOR_MEMBER_MESSAGE =
  'This npm version does not find the workspace root from a package folder, so it would write a different lockfile. Update npm to enable changes.';

/** Whether this npm writes the workspace root's lockfile from a member folder. An unreadable version is treated as too old. */
export function npmFindsWorkspaceRoot(version: string | undefined): boolean {
  const parsed = version === undefined ? null : semver.coerce(version);
  return parsed !== null && semver.gte(parsed, NPM_WORKSPACE_MEMBER_MIN_VERSION);
}

const DISPOSED_OUTCOME: UpgradeRunOutcome = {
  ok: false,
  status: 'unknown',
  code: 'OUTCOME_UNKNOWN',
  message: 'The task result was not observed.',
};

export const STILL_RUNNING_THRESHOLD_MS = 10_000;

/**
 * Tracks the panel-wide upgrade lock and in-flight task-completion listeners
 * for one panel. One instance per DashboardPanel. `dispose()` from the
 * panel's onDidDispose so neither a stray listener, a held lock, nor a
 * permanently-pending `run()` Promise outlives the panel.
 */
export class UpgradeExecutionSession {
  private readonly lock = new UpgradeLock();
  private readonly listeners = new Set<Disposable>();
  private readonly pendingRuns = new PendingUpgradeRuns();
  journal: { record(step: string, phase: 'intent' | 'finished'): Promise<void>; assertWritable?(): void } | undefined;

  constructor(
    private readonly platform: HostPlatform,
    /** Test seam. Production resolves the real npm or pnpm for `cwd`. */
    private readonly invocationResolver?: (cwd: string, packageManager: 'npm' | 'pnpm') => PackageManagerInvocation | null,
    private onTaskState?: (state: DependencyTaskState) => void
  ) {}

  /** The coordinator installs this only when a user requests a change. */
  observeTaskState(listener: (state: DependencyTaskState) => void): void {
    this.onTaskState = listener;
  }


  /**
   * Reserves the panel's single upgrade slot for `packageName` for the whole
   * confirm-then-run flow: called by DashboardPanel before showing the
   * confirmation dialog, not just before running the task. Reserving only
   * inside `run()` would still guarantee at most one running task, but
   * would let a flood of forged requests each independently reach (and
   * stack) their confirmation dialog. One upgrade at a time for the
   * whole panel, not one per package: two `npm install`s racing to write
   * the same package.json/lockfile is unsafe regardless of which packages
   * they target. Returns false if a reservation is already held, for any
   * package. The caller must call `release` exactly once for every
   * reservation that succeeds, whichever way the flow ends (cancelled,
   * rejected, or run).
   */
  reserve(packageName: string): boolean {
    return this.lock.tryAcquire(packageName);
  }

  release(packageName: string): void {
    this.lock.release(packageName);
  }

  /** Whether the panel's single upgrade slot is currently held, by anyone: gates manual refresh from starting during an active upgrade. */
  isBusy(): boolean {
    return this.lock.isHeld();
  }

  /**
   * Re-checks Workspace Trust as the very first thing this method does,
   * called immediately after confirmation resolves true, so this is the
   * last gate before anything executes, closest to execution time. Assumes
   * the caller already holds a reservation via `reserve`: this method does
   * not itself track or release one.
   */
  async run(params: UpgradeRunParams): Promise<UpgradeRunOutcome> {
    if (!this.platform.isWorkspaceTrusted()) {
      return {
        ok: false,
        code: 'UNTRUSTED_WORKSPACE',
        message: 'Upgrades are disabled in untrusted workspaces.',
      };
    }

    // params.cwd is also the eventual task's cwd (see executeTask below),
    // the identical, single-read value, so a Volta pin (which depends on the
    // working directory) resolves the same way during this validation as it
    // will during the actual visible task.
    const invocation = this.resolveInvocation(params.cwd, params.packageManager, true);
    if (invocation === null) {
      this.platform.showErrorMessage(
        params.packageManager === 'pnpm' ? PNPM_NOT_FOUND_MESSAGE : `Packageawy could not locate a working ${params.packageManager} installation.`
      );
      return {
        ok: false,
        code: 'PACKAGE_MANAGER_NOT_FOUND',
        message: params.packageManager === 'pnpm' ? PNPM_NOT_FOUND_MESSAGE : `A working ${params.packageManager} installation could not be located.`,
      };
    }

    const workspace = {
      importerId: params.importerId ?? '.',
      hasWorkspaceManifest: existsSync(path.join(params.cwd, 'pnpm-workspace.yaml')),
    };
    const args =
      params.coordinatedChanges !== undefined && params.coordinatedChanges.length > 1
        ? buildCoordinatedInstallArgs(params.packageManager, {
            changes: params.coordinatedChanges,
            workspace,
            ignoreScripts: params.ignoreScripts,
          })
        : buildInstallArgs(params.packageManager, {
            packageName: params.packageName,
            workspace,
            target: params.target,
            classification: params.classification,
            ignoreScripts: params.ignoreScripts,
          });
    return await this.executeTask(
      invocation,
      params.cwd,
      params.packageName,
      args,
      `Packageawy: Upgrade ${params.packageName}`,
      `${params.packageManager} ${args[0]}`
    );
  }

  /**
   * Authorize and resolve a manifest reconciliation before package.json is
   * staged. The returned execution captures the trusted JS entrypoint and
   * literal argv, and may be invoked exactly once after staging. This split
   * prevents an untrusted workspace or missing package manager from causing
   * even a transient manifest mutation.
   */
  prepareManifestReconciliation(
    params: UpgradeManifestReconciliationParams
  ): PreparedManifestReconciliation {
    if (!this.platform.isWorkspaceTrusted()) {
      return {
        ok: false,
        code: 'UNTRUSTED_WORKSPACE',
        message: 'Upgrades are disabled in untrusted workspaces.',
      };
    }

    const { cwd, packageManager, ignoreScripts } = params;
    const resolved = this.resolveInvocationFor(cwd, packageManager, params.workspaceMember === true, true);
    if (!resolved.ok) return resolved;
    const invocation = resolved.invocation;

    const reconcileArgs = buildManifestReconciliationArgs(packageManager, {
      ignoreScripts,
      ...(params.lockfileOnly === true ? { lockfileOnly: true } : {}),
      workspace: {
        importerId: params.importerId ?? '.',
        hasWorkspaceManifest: existsSync(path.join(cwd, 'pnpm-workspace.yaml')),
      },
    });
    let executed = false;
    return {
      ok: true,
      execute: async (): Promise<UpgradeRunOutcome> => {
        if (executed) {
          return {
            ok: false,
            code: 'RECONCILIATION_ALREADY_EXECUTED',
            message: 'The prepared manifest reconciliation has already been executed.',
          };
        }
        executed = true;
        if (!this.platform.isWorkspaceTrusted()) {
          return {
            ok: false,
            code: 'UNTRUSTED_WORKSPACE',
            message: 'Upgrades are disabled in untrusted workspaces.',
          };
        }
        return await this.executeTask(
          invocation,
          cwd,
          params.taskScope ?? 'smart-cleanup',
          reconcileArgs,
          params.taskTitle ?? 'Packageawy: Reconcile cleanup changes',
          `${packageManager} ${reconcileArgs[0]}`
        );
      },
    };
  }

  /**
   * Authorize and resolve an exact-lockfile reconciliation before the host
   * stages that lockfile through the transaction's compare-and-swap boundary.
   * The prepared execution is one-shot and re-checks Workspace Trust at the
   * last possible moment, matching manifest reconciliation's safety model.
   */
  prepareLockfileReconciliation(
    params: UpgradeLockfileReconciliationParams
  ): PreparedLockfileReconciliation {
    if (!this.platform.isWorkspaceTrusted()) {
      return {
        ok: false,
        code: 'UNTRUSTED_WORKSPACE',
        message: 'Upgrades are disabled in untrusted workspaces.',
      };
    }

    const { cwd, packageManager, ignoreScripts, taskTitle } = params;
    const resolved = this.resolveInvocationFor(cwd, packageManager, params.workspaceMember === true, true);
    if (!resolved.ok) return resolved;
    const invocation = resolved.invocation;

    const args = buildLockfileReconciliationArgs(packageManager, { ignoreScripts });
    let executed = false;
    return {
      ok: true,
      execute: async (): Promise<UpgradeRunOutcome> => {
        if (executed) {
          return {
            ok: false,
            code: 'RECONCILIATION_ALREADY_EXECUTED',
            message: 'The prepared lockfile reconciliation has already been executed.',
          };
        }
        executed = true;
        if (!this.platform.isWorkspaceTrusted()) {
          return {
            ok: false,
            code: 'UNTRUSTED_WORKSPACE',
            message: 'Upgrades are disabled in untrusted workspaces.',
          };
        }
        return await this.executeTask(
          invocation,
          cwd,
          'transitive-remediation',
          args,
          taskTitle ?? 'Packageawy: Apply transitive security fix',
          `${packageManager} ${args[0]}`
        );
      },
    };
  }

  /** Runs only host-selected package.json script names, one visible task at a time. */
  async verify(params: UpgradeVerificationParams): Promise<VerificationExecutionResult> {
    if (!this.platform.isWorkspaceTrusted()) {
      return { status: 'failed', checks: [], message: 'Verification is disabled in untrusted workspaces.' };
    }
    const invocation = this.resolveInvocation(params.cwd, params.packageManager, true);
    if (invocation === null) {
      return { status: 'failed', checks: [], message: params.packageManager === 'pnpm' ? PNPM_NOT_FOUND_MESSAGE : `A working ${params.packageManager} installation could not be located.` };
    }

    const checks: Array<{ id: string; status: 'passed' | 'failed'; message?: string }> = [];
    const cancelled = (): boolean => params.signal?.aborted === true;
    for (const script of params.scripts) {
      if (cancelled()) return { status: 'cancelled', checks };
      const outcome = await this.executeTask(
        invocation,
        params.cwd,
        params.packageName,
        buildVerificationScriptArgs(params.packageManager, script.scriptName),
        `Packageawy: Verify ${script.scriptName}`,
        `${params.packageManager} run ${script.scriptName}`
      );
      if (!outcome.ok && outcome.status === 'unknown') return { status: 'unknown', checks, message: outcome.message };
      if (cancelled()) return { status: 'cancelled', checks };
      if (!outcome.ok) {
        checks.push({ id: script.id, status: 'failed', message: outcome.message });
        return { status: 'failed', checks, message: `Verification script ${script.scriptName} failed.` };
      }
      checks.push({ id: script.id, status: 'passed' });
    }
    return { status: 'passed', checks };
  }

  private resolveInvocation(cwd: string, packageManager: 'npm' | 'pnpm', strict = false): PackageManagerInvocation | null {
    if (this.invocationResolver !== undefined) return this.invocationResolver(cwd, packageManager);
    const npm = resolveNpmInvocation(createNodeNpmResolverDeps(cwd, strict));
    if (packageManager === 'npm') {
      if (!npm.ok) return null;
      return { executable: npm.invocation.node, prefixArgs: [npm.invocation.npmCliJs], version: npm.invocation.version };
    }
    return resolveInstalledPnpmInvocation(npm.ok ? npm.invocation : null, cwd, strict);
  }

  /**
   * The invocation a reconciliation will run, or the refusal to report.
   * Checked before anything is staged, so a refusal writes nothing.
   */
  private resolveInvocationFor(
    cwd: string,
    packageManager: 'npm' | 'pnpm',
    workspaceMember: boolean,
    strict = false
  ): { ok: true; invocation: PackageManagerInvocation } | { ok: false; code: string; message: string } {
    const invocation = this.resolveInvocation(cwd, packageManager, strict);
    if (invocation === null) {
      this.platform.showErrorMessage(
        packageManager === 'pnpm' ? PNPM_NOT_FOUND_MESSAGE : `Packageawy could not locate a working ${packageManager} installation.`
      );
      return {
        ok: false,
        code: 'PACKAGE_MANAGER_NOT_FOUND',
        message: packageManager === 'pnpm' ? PNPM_NOT_FOUND_MESSAGE : `A working ${packageManager} installation could not be located.`,
      };
    }
    if (packageManager === 'npm' && workspaceMember && !npmFindsWorkspaceRoot(invocation.version)) {
      return { ok: false, code: NPM_TOO_OLD_FOR_MEMBER_CODE, message: NPM_TOO_OLD_FOR_MEMBER_MESSAGE };
    }
    return { ok: true, invocation };
  }

  private async executeTask(
    invocation: PackageManagerInvocation,
    cwd: string,
    packageName: string,
    args: readonly string[],
    taskName: string,
    failureCommand: string
  ): Promise<UpgradeRunOutcome> {
    // An argument array, never a shell string: `invocation.node` and every
    // element of `[invocation.npmCliJs, ...args]` reach the process as
    // literal argv entries, with no shell parsing step in between for a
    // hostile character to exploit, and no npm/npm.cmd shim layer either.
    // `params.cwd` here is the same single-read value passed to
    // `createNodeNpmResolverDeps` in `run` above: resolution and execution
    // never see different working directories.
    const request = {
      executable: invocation.executable,
      args: [...invocation.prefixArgs, ...args],
      cwd,
      title: taskName,
      scope: packageName,
    };

    await this.journal?.record(taskName, 'intent');
    this.onTaskState?.('running');
    // This timer only explains the wait. Visible writers have no deadline.
    const stillRunning = setTimeout(() => this.onTaskState?.('still-running'), STILL_RUNNING_THRESHOLD_MS);
    const outcome = await new Promise<UpgradeRunOutcome>((resolve) => {
      let settled = false;
      // A Disposable only stops future events: disposing the
      // onDidExit listener below does not, by itself, resolve this
      // Promise. `untrack` (called on the normal completion path) removes
      // this callback so `dispose()` doesn't double-settle an already-
      // finished run. If `dispose()` fires first, it calls this and the
      // pending run resolves with DISPOSED instead of hanging forever.
      const untrack = this.pendingRuns.track(() => {
        if (settled) return;
        settled = true;
        resolve(DISPOSED_OUTCOME);
      });
      const finish = (outcome: UpgradeRunOutcome): void => {
        if (settled) return;
        settled = true;
        untrack();
        resolve(outcome);
      };

      Promise.resolve().then(() => {
        this.journal?.assertWritable?.();
        return this.platform.runProcess(request);
      }).then(
        (started) => {
          // dispose() already settled this run (DISPOSED) while runProcess
          // was still pending: don't register a listener for a session that
          // is already torn down. The process itself keeps running regardless,
          // we simply stop caring about its outcome from here.
          if (settled) return;
          let disposable: Disposable | undefined;
          disposable = started.onDidExit((exitCode) => {
            disposable?.dispose();
            if (disposable !== undefined) this.listeners.delete(disposable);
            finish(
              exitCode === undefined ? { ok: false, status: 'unknown', code: 'OUTCOME_UNKNOWN', message: 'The task result was not observed.' } : isSuccessfulExitCode(exitCode)
                ? { ok: true }
                : {
                    ok: false,
                    code: 'TASK_FAILED',
                    message: `${failureCommand} exited with code ${exitCode ?? 'unknown'}.`,
                  }
            );
          });
          if (settled) disposable.dispose();
          else this.listeners.add(disposable);
        },
        (error: unknown) => {
          finish({
            ok: false,
            status: 'unknown',
            code: 'OUTCOME_UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      ).catch((error: unknown) => finish({ ok: false, status: 'unknown', code: 'OUTCOME_UNKNOWN', message: error instanceof Error ? error.message : String(error) }));
    });
    clearTimeout(stillRunning);
    this.onTaskState?.('idle');
    if (outcome.ok || outcome.status !== 'unknown') {
      try { await this.journal?.record(taskName, 'finished'); }
      catch { return { ok: false, status: 'unknown', code: 'OUTCOME_UNKNOWN', message: 'The task result could not be recorded.' }; }
    }
    return outcome;
  }

  dispose(): void {
    for (const disposable of this.listeners) disposable.dispose();
    this.listeners.clear();
    // Settle every still-pending run (DISPOSED) so nothing awaits forever,
    // a running npm install itself is deliberately left to finish on its own
    // in its own terminal rather than being killed: aborting a
    // package.json/lockfile write mid-flight would be worse than letting it
    // complete after the dashboard closed.
    this.pendingRuns.settleAll();
    // The owner handle settles after observing disposal as unknown.
  }
}
