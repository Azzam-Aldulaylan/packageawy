/**
 * The install step of an upgrade that keeps declared range styles.
 *
 * Pass one reconciles a manifest holding exact targets, so the package
 * manager resolves exactly the reviewed versions. When any declaration had a
 * ^ or ~ operator, the host then swaps in the styled manifest and runs a
 * lockfile-only pass that records the styled specifiers. No `vscode` import.
 */

import type { UpgradeRunOutcome } from './upgradeRunner.js';
import type { InstallExecutionResult, UpgradeInstallExecutor } from './upgradeTransaction.js';

export type ReconcileOutcome = UpgradeRunOutcome;

export interface RangePreservingInstallOptions {
  manifestPath: string;
  /** Exact-target manifest the transaction staged before install. */
  stagedManifest: string;
  /** Same edit with declaration styles kept. Equal to stagedManifest when there is nothing to restyle. */
  styledManifest: string;
  resolve: () => Promise<ReconcileOutcome>;
  /** Lockfile-only reconciliation, or null when no restyle is needed. */
  restyle: (() => Promise<ReconcileOutcome>) | null;
}

function failed(outcome: Extract<ReconcileOutcome, { ok: false }>): InstallExecutionResult {
  return { ...(outcome.status === 'unknown' ? { status: 'unknown' as const, message: outcome.message } : { status: 'failed' as const, code: outcome.code, message: outcome.message }), ...(outcome.command === undefined ? {} : { commands: [outcome.command], ...(outcome.command.exitCode === undefined ? {} : { exitCode: outcome.command.exitCode }) }) };
}

export function createRangePreservingInstall(options: RangePreservingInstallOptions): UpgradeInstallExecutor {
  return {
    execute: async (context) => {
      const resolved = await options.resolve();
      if (!resolved.ok) return failed(resolved);
      if (options.restyle === null || options.styledManifest === options.stagedManifest) {
        return { status: 'succeeded', ...(resolved.command === undefined ? {} : { commands: [resolved.command], exitCode: resolved.command.exitCode }) };
      }
      const staged = { exists: true as const, contents: Buffer.from(options.stagedManifest, 'utf8') };
      // Written through the transaction so the styled bytes become the
      // rollback expectation from here on.
      const swapped = await context.compareAndSwap(options.manifestPath, staged, {
        exists: true,
        contents: Buffer.from(options.styledManifest, 'utf8'),
      });
      if (swapped !== 'restored') {
        // Someone else wrote package.json during pass one. Rollback compares
        // against the staged bytes the transaction owns and keeps their file.
        return {
          status: 'failed',
          ...(resolved.command === undefined ? {} : { commands: [resolved.command] }),
          code: 'STALE_SOURCE',
          message: 'package.json changed while the upgrade was installing. The upgrade was not kept.',
        };
      }
      const restyled = await options.restyle();
      return { ...(restyled.ok ? { status: 'succeeded' as const, ...(restyled.command?.exitCode === undefined ? {} : { exitCode: restyled.command.exitCode }) } : failed(restyled)), ...([resolved.command, restyled.command].some(Boolean) ? { commands: [resolved.command, restyled.command].filter((command): command is NonNullable<typeof command> => command !== undefined) } : {}) };
    },
  };
}
