import { SAFE_SCRIPT_NAME } from '../core/upgrade/verificationSuggestions.js';
import type { ProjectCheckResult } from './webviewProtocol.js';
import type { UpgradeTransactionResult } from './upgradeTransaction.js';
import type { VerificationScript } from './verificationPolicy.js';

export interface ScriptSnapshot { id: string; scriptName: string; present: boolean | null; selected: boolean }

/** Taken from the manifest that passed confirmation, before any command runs. */
export function snapshotProjectScripts(manifestText: string, configured: readonly unknown[], selected: readonly VerificationScript[]): ScriptSnapshot[] {
  let manifest: unknown;
  try { manifest = JSON.parse(manifestText); } catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; return []; }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return [];
  const raw = (manifest as Record<string, unknown>)['scripts'];
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) return [];
  const scripts = (raw ?? {}) as Record<string, unknown>;
  const names = new Set(['test', ...Object.keys(scripts).filter(name => /^(?:test|build|lint|typecheck|check)(?::|$)/.test(name)), ...configured.filter((name): name is string => typeof name === 'string'), ...selected.map(script => script.scriptName)]);
  return [...names].filter(name => SAFE_SCRIPT_NAME.test(name)).map(scriptName => ({
    id: `package-script:${scriptName}`, scriptName,
    present: !Object.hasOwn(scripts, scriptName) ? false : typeof scripts[scriptName] === 'string' ? true : null,
    selected: selected.some(script => script.scriptName === scriptName),
  }));
}

export function projectChecks(transaction: UpgradeTransactionResult, snapshot: readonly ScriptSnapshot[], packageManager: 'npm' | 'pnpm'): ProjectCheckResult[] {
  const install = transaction.install;
  const checks: ProjectCheckResult[] = install.commands === undefined ? [{
    id: 'install', kind: 'install', command: `${packageManager} install`,
    status: install.status === 'succeeded' ? 'passed' : install.status === 'failed' ? 'failed' : install.status === 'not-run' ? 'not-run' : 'unknown',
    ...(install.status === 'not-run' ? { reason: 'Install did not start.' } : {}),
    ...((install.status === 'succeeded' || install.status === 'failed') && 'exitCode' in install && typeof install.exitCode === 'number' ? { exitCode: install.exitCode } : {}),
    ...('message' in install ? { message: install.message } : {}),
  }] : [...install.commands];
  const verification = transaction.verification;
  const observed = verification.status === 'not-run' ? [] : verification.checks;
  for (const script of snapshot) {
    const result = observed.find(check => check.scriptName === script.scriptName || check.id === script.id);
    checks.push(result !== undefined ? {
      id: result.commandId ?? result.id, kind: 'script', scriptName: script.scriptName, command: `${packageManager} run ${script.scriptName}`,
      status: result.status === 'cancelled' ? 'unknown' : result.status,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.message === undefined ? {} : { message: result.message }),
      ...(result.terminalAvailable ? { terminalAvailable: true } : {}),
    } : {
      id: script.id, kind: 'script', scriptName: script.scriptName, command: `${packageManager} run ${script.scriptName}`,
      status: script.present === false ? 'no-script' : script.present === null || (script.selected && (verification.status === 'unknown' || verification.status === 'cancelled')) ? 'unknown' : 'not-run',
      reason: script.present === false ? `No ${script.scriptName} script in package.json.` : script.present === null ? 'The script definition in package.json is not a string.' : !script.selected ? 'Not selected.'
        : verification.status === 'not-run' && verification.reason === 'install-failed' ? 'Stopped after install failed.'
          : verification.status === 'not-run' && verification.reason === 'cancelled' ? 'Cancelled before this script started.'
          : verification.status === 'cancelled' ? 'Verification was cancelled before this command result was observed.'
            : verification.status === 'unknown' ? 'The command result was not observed.' : 'Stopped after an earlier failure.',
    });
  }
  return checks;
}
