import type { UpgradeTransactionResult } from './upgradeTransaction.js';
import type { ProtocolError, UpgradeResultPresentation } from './webviewProtocol.js';
import { manualReinstallNote } from './manualReinstallCopy.js';

/** The sole application-state gate: task success alone never authorizes "applied". */
export function classifyUpgradeApplication(
  completion: UpgradeTransactionResult['completion'],
  structurallyCurrent: boolean,
  locallyConfirmed: boolean
): UpgradeResultPresentation['application'] {
  if (completion === 'rolled-back') return 'rolled-back';
  return completion === 'kept' && structurallyCurrent && locallyConfirmed ? 'applied' : 'unconfirmed';
}

/** A generation-raced snapshot may be displayed, but never enriched as current. */
export function classifyMutationEnrichmentStart(
  structurallyCurrent: boolean
): 'start-targeted' | 'superseded' {
  return structurallyCurrent ? 'start-targeted' : 'superseded';
}

export function canRetryMutationEnrichment(
  current: { refreshId: string; state: string } | undefined,
  requestedRefreshId: string
): boolean {
  return (
    current?.refreshId === requestedRefreshId &&
    (current.state === 'failed' || current.state === 'cancelled')
  );
}

export type UpgradeCompletionPresentation =
  | { kind: 'verified'; message: string }
  | { kind: 'unverified'; message: string }
  | { kind: 'unconfirmed'; message: string }
  | { kind: 'rolled-back'; message: string }
  | { kind: 'error'; error: ProtocolError };

/**
 * Converts the transaction state machine's result into the exact host-facing
 * outcome shown to the user. Keeping this pure makes the distinction between
 * a file rollback and an installed-module rollback explicit and testable.
 */
export function describeUpgradeTransactionOutcome(
  packageName: string,
  packageManager: 'npm' | 'pnpm',
  transaction: UpgradeTransactionResult,
  appliedStateConfirmed = true
): UpgradeCompletionPresentation {
  // Rollback status takes precedence over completion. This avoids ever
  // overstating restoration if a malformed or future result combines an
  // optimistic completion value with a conflict/I/O failure.
  if (transaction.rollback.status === 'conflict') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_CONFLICT',
        message:
          'Rollback is incomplete because Packageawy saw dependency files change. Saved and displaced files are kept. ' +
          `Check ${transaction.rollback.files.filter(file => file.status !== 'restored').map(file => file.path.split(/[\\/]/).at(-1)).join(', ') || 'the dependency files'}. ${manualReinstallNote(packageManager)}`,
      },
    };
  }
  if (transaction.rollback.status === 'failed') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_FAILED',
        message:
          'Rollback is incomplete. Saved and displaced files are kept. ' +
          `Check ${transaction.rollback.files.filter(file => file.status !== 'restored').map(file => file.path.split(/[\\/]/).at(-1)).join(', ') || 'the dependency files'}. ${manualReinstallNote(packageManager)}`,
      },
    };
  }

  if (transaction.reason === 'manifest-stage-failed' && transaction.manifestStage.status === 'failed') {
    return transaction.manifestStage.code === 'CONFLICT'
      ? {
          kind: 'error',
          error: {
            code: 'STALE_SOURCE',
            message: 'package.json changed before the coordinated upgrade could start. No upgrade files were modified. Refresh and try again.',
          },
        }
      : {
          kind: 'error',
          error: {
            code: 'MANIFEST_STAGE_FAILED',
            message: 'The coordinated package.json changes could not be staged, so the package-manager install was not started.',
          },
        };
  }

  if (transaction.completion === 'kept' && !appliedStateConfirmed) {
    return {
      kind: 'unconfirmed',
      message: 'Install completed, but the resulting dependency state could not be confirmed.',
    };
  }
  if (transaction.completion === 'kept' && transaction.reason === 'verified') {
    return { kind: 'verified', message: `Upgrade applied to ${packageName}. Verification passed.` };
  }
  if (transaction.completion === 'kept') {
    return {
      kind: 'unverified',
      message:
        transaction.verification.status === 'failed'
          ? `Upgrade applied to ${packageName}, but verification failed and the changes were kept.`
          : `Upgrade applied to ${packageName}. Verification is not configured.`,
    };
  }
  if (transaction.completion === 'rolled-back') {
    return {
      kind: 'rolled-back',
      message:
        `Dependency files for ${packageName} were restored to their pre-upgrade state.`,
    };
  }

  return {
    kind: 'error',
    error: {
      code: 'UPGRADE_TRANSACTION_FAILED',
      message: 'The upgrade transaction did not reach a verified or fully restored state. Review package.json and the lockfile.' +
        (transaction.completion === 'incomplete' ? ` ${manualReinstallNote(packageManager)}` : ''),
    },
  };
}

export function describeRemovedPackages(packageNames: readonly string[]): string {
  return packageNames.length === 1 ? (packageNames[0] ?? '') : `${packageNames.length} dependencies`;
}

/** describeUpgradeTransactionOutcome's removal analog: same transaction result shape, same precedence rules, remove-specific wording. */
export function describeRemoveTransactionOutcome(
  packageNames: readonly string[],
  packageManager: 'npm' | 'pnpm',
  transaction: UpgradeTransactionResult
): UpgradeCompletionPresentation {
  const removed = describeRemovedPackages(packageNames);
  const applied = `Removed ${removed}`;

  if (transaction.rollback.status === 'conflict') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_CONFLICT',
        message:
          'Rollback is incomplete because Packageawy saw dependency files change. Saved and displaced files are kept. ' +
          `Check ${transaction.rollback.files.filter(file => file.status !== 'restored').map(file => file.path.split(/[\\/]/).at(-1)).join(', ') || 'the dependency files'}. ${manualReinstallNote(packageManager)}`,
      },
    };
  }
  if (transaction.rollback.status === 'failed') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_FAILED',
        message:
          'Rollback is incomplete. Saved and displaced files are kept. ' +
          `Check ${transaction.rollback.files.filter(file => file.status !== 'restored').map(file => file.path.split(/[\\/]/).at(-1)).join(', ') || 'the dependency files'}. ${manualReinstallNote(packageManager)}`,
      },
    };
  }

  if (transaction.reason === 'manifest-stage-failed' && transaction.manifestStage.status === 'failed') {
    return transaction.manifestStage.code === 'CONFLICT'
      ? {
          kind: 'error',
          error: {
            code: 'STALE_SOURCE',
            message: 'package.json changed before the removal could start. No files were modified. Refresh and try again.',
          },
        }
      : {
          kind: 'error',
          error: {
            code: 'MANIFEST_STAGE_FAILED',
            message: 'The package.json removal could not be staged, so the package-manager install was not started.',
          },
        };
  }

  if (transaction.completion === 'kept' && transaction.reason === 'verified') {
    return { kind: 'verified', message: `${applied}. Verification passed.` };
  }
  if (transaction.completion === 'kept') {
    return {
      kind: 'unverified',
      message: `${applied}, but the application is not verified after cleanup.`,
    };
  }
  if (transaction.completion === 'rolled-back') {
    return {
      kind: 'rolled-back',
      message:
        `Dependency files for ${removed} were restored to their pre-removal state.`,
    };
  }

  return {
    kind: 'error',
    error: {
      code: 'REMOVE_TRANSACTION_FAILED',
      message: 'The removal transaction did not reach a verified or fully restored state. Review package.json and the lockfile.' +
        (transaction.completion === 'incomplete' ? ` ${manualReinstallNote(packageManager)}` : ''),
    },
  };
}
