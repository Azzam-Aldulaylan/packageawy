import { createHash, randomUUID } from 'node:crypto';
import type { FileState } from '../upgradeTransaction.js';
import { isRecord } from '../../core/validation.js';

export const RECOVERY_FOLDER = '.packageawy-recovery';
export { RECOVERY_MESSAGES } from '../recoveryCopy.js';

export type Operation = 'upgrade' | 'removal' | 'remediation' | 'cleanup';
export type Outcome = 'running' | 'unknown' | 'completed' | 'rolled-back' | 'rollback-incomplete' | 'recovery-incomplete' | 'removing';
export type Expected = { kind: 'absent' } | { kind: 'present'; sha256: string } | { kind: 'unknown' };
export interface RecoveryTarget {
  workspaceRoot: string;
  root: string;
  identity: string;
  allowlistedPaths: readonly string[];
  operation: Operation;
  hostKind: 'vscode' | 'jetbrains';
}
export interface Owner {
  version: 1;
  transactionId: string;
  ownerToken: string;
  hostKind: 'vscode' | 'jetbrains';
  createdAt: string;
  targetIdentity: string;
}
export interface Claim { token: string; createdAt: string; previousToken: string | null }
export interface Backup {
  id: string;
  path: string;
  existed: boolean;
  mode: number;
  sha256: string | null;
  transactionId: string;
  ownerToken: string;
}
export interface JournalFile {
  backup: Backup;
  expected: Expected;
  progress: 'pending' | 'keep' | 'displace' | 'displaced' | 'restored' | 'unknown';
  displacedIds: string[];
  move?: { id: string; before: Expected };
}
export interface Journal {
  version: 1;
  transactionId: string;
  ownerToken: string;
  claimToken: string | null;
  sequence: number;
  operation: Operation;
  phase: string;
  step: string;
  outcome: Outcome;
  files: JournalFile[];
}
export const newId = (): string => randomUUID();
export const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const expectation = (state: FileState): Expected => state.exists ? { kind: 'present', sha256: hash(state.contents) } : { kind: 'absent' };
export function matches(expected: Expected, state: FileState): boolean {
  return expected.kind === 'absent' ? !state.exists : expected.kind === 'present' && state.exists && hash(state.contents) === expected.sha256;
}
export function isOwner(value: unknown): value is Owner {
  return isRecord(value) && value['version'] === 1 && isId(value['transactionId']) && isId(value['ownerToken']) &&
    ['vscode', 'jetbrains'].includes(value['hostKind'] as string) && typeof value['createdAt'] === 'string' && typeof value['targetIdentity'] === 'string';
}
export function isClaim(value: unknown): value is Claim {
  return isRecord(value) && isId(value['token']) && typeof value['createdAt'] === 'string' && (value['previousToken'] === null || isId(value['previousToken']));
}
export function isBackup(value: unknown): value is Backup {
  return isRecord(value) && isId(value['id']) && typeof value['path'] === 'string' && typeof value['existed'] === 'boolean' &&
    Number.isInteger(value['mode']) && (value['mode'] as number) >= 0 && (value['mode'] as number) <= 0o777 &&
    (value['existed'] ? isHash(value['sha256']) : value['sha256'] === null) && isId(value['transactionId']) && isId(value['ownerToken']);
}
function isExpected(value: unknown): value is Expected {
  return isRecord(value) && (value['kind'] === 'unknown' || value['kind'] === 'absent' || (value['kind'] === 'present' && isHash(value['sha256'])));
}
export function isJournal(value: unknown): value is Journal {
  return isRecord(value) && value['version'] === 1 && isId(value['transactionId']) && isId(value['ownerToken']) &&
    (value['claimToken'] === null || isId(value['claimToken'])) && Number.isSafeInteger(value['sequence']) && (value['sequence'] as number) >= 0 &&
    ['upgrade', 'removal', 'remediation', 'cleanup'].includes(value['operation'] as string) &&
    ['running', 'unknown', 'completed', 'rolled-back', 'rollback-incomplete', 'recovery-incomplete', 'removing'].includes(value['outcome'] as string) &&
    typeof value['phase'] === 'string' && typeof value['step'] === 'string' && Array.isArray(value['files']) && value['files'].length <= 1000 &&
    value['files'].every((file: unknown) => isRecord(file) && isBackup(file['backup']) && isExpected(file['expected']) &&
      ['pending', 'keep', 'displace', 'displaced', 'restored', 'unknown'].includes(file['progress'] as string) &&
      Array.isArray(file['displacedIds']) && file['displacedIds'].every(isId) &&
      (file['move'] === undefined || (isRecord(file['move']) && isId(file['move']['id']) && isExpected(file['move']['before']) && file['displacedIds'].includes(file['move']['id']))));
}
export class RecoveryError extends Error {}
