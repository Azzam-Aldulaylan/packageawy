import type { HostToWebviewMessage, RecoveryPresentation } from './webviewProtocol.js';

export function isUnknownChangeMessage(message: HostToWebviewMessage): boolean {
  return (message.status === 'upgrade-error' || message.status === 'remove-error' || message.status === 'remediation-error') &&
    message.error.code === 'OUTCOME_UNKNOWN';
}

export function dependencyChangesBlocked(recovery: RecoveryPresentation | null): boolean {
  return recovery !== null && recovery.state !== 'none' && recovery.state !== 'running';
}
