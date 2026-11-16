import { createContext, useContext } from 'react';
import type { ReactElement } from 'react';
import type { DependencyTaskState } from '../../../src/host/webviewProtocol.js';
import { RECOVERY_MESSAGES } from '../../../src/host/recoveryCopy.js';
import { StatusBanner } from './StatusBanner.js';

export const DependencyChangeContext = createContext<{
  task: DependencyTaskState;
  blocked: boolean;
  message?: string;
  retryDiscovery?: boolean;
  protocolMismatch?: boolean;
  openRecovery(): void;
}>({ task: 'idle', blocked: false, openRecovery() {} });

/** One status in the current surface, shared by dashboard and review screens. */
export function DependencyChangeStatus(): ReactElement | null {
  const change = useContext(DependencyChangeContext);
  // The dashboard owns the single protocol banner and its reload action.
  if (change.protocolMismatch) return null;
  if (change.blocked) {
    return <StatusBanner tone={change.retryDiscovery ? 'error' : 'warning'} action={{ label: change.retryDiscovery ? 'Retry discovery' : 'Start recovery', onClick: change.openRecovery }}>{change.message ?? RECOVERY_MESSAGES.blocked}</StatusBanner>;
  }
  if (change.task !== 'still-running') return null;
  return <StatusBanner tone="info">{RECOVERY_MESSAGES.stillRunning}</StatusBanner>;
}
