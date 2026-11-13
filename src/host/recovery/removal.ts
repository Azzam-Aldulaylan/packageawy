import { isOwner, isClaim, isId, RECOVERY_MESSAGES, RecoveryError, type Owner, type Journal } from './model.js';
import { Storage } from './storage.js';

export const isTemporary = (name: string): boolean => name.lastIndexOf('.tmp-') > 0 && isId(name.slice(name.lastIndexOf('.tmp-') + 5));
const isAbandoned = (name: string): boolean => name.startsWith('claim.') && name.endsWith('.abandoned') && isId(name.slice(6, -10));

/** Validate the entire deletion set before deleting even one known entry. */
async function inventory(storage: Storage, data: Journal | undefined): Promise<{ root: string[]; backups: string[]; displaced: string[] }> {
  const root = await storage.list();
  const allowed = new Set(['.gitignore', 'owner.json', 'journal.json', 'claim.json', 'backups', 'displaced']);
  for (const name of root) {
    if (!allowed.has(name) && !isAbandoned(name) && !isTemporary(name)) throw new RecoveryError(name === 'takeover' ? RECOVERY_MESSAGES.interruptedTakeover : RECOVERY_MESSAGES.unrecognized);
    const info = await storage.fs.lstat(await storage.at(name));
    if (name === 'backups' || name === 'displaced') {
      if (!info.isDirectory()) throw new RecoveryError(RECOVERY_MESSAGES.unrecognized);
    } else if (!info.isFile()) throw new RecoveryError(RECOVERY_MESSAGES.unrecognized);
  }
  const entries = async (directory: string): Promise<string[]> => root.includes(directory) ? storage.list(directory) : [];
  const backups = await entries('backups');
  const displaced = await entries('displaced');
  const knownBackup = new Set(data?.files.flatMap((file) => [`${file.backup.id}.json`, ...(file.backup.existed ? [`${file.backup.id}.bin`] : [])]) ?? []);
  const knownDisplaced = new Set(data?.files.flatMap((file) => file.displacedIds.map((id) => `${id}.bin`)) ?? []);
  for (const [directory, names, known] of [['backups', backups, knownBackup], ['displaced', displaced, knownDisplaced]] as const) {
    for (const name of names) {
      if (!known.has(name) && !isTemporary(name)) throw new RecoveryError(RECOVERY_MESSAGES.unrecognized);
      const info = await storage.fs.lstat(await storage.at(`${directory}/${name}`));
      if (!info.isFile() || info.isSymbolicLink()) throw new RecoveryError(RECOVERY_MESSAGES.unrecognized);
    }
  }
  return { root, backups, displaced };
}

/** The identity is captured once and checked at every later durable boundary. */
export async function removeSavedFiles(storage: Storage, identity: Owner, data: Journal | undefined, claimToken: string | null, assertActive?: () => Promise<void>): Promise<void> {
  const checkIdentity = async (): Promise<void> => {
    const current = await storage.json('owner.json');
    if (!isOwner(current) || current.transactionId !== identity.transactionId || current.ownerToken !== identity.ownerToken) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
    if (await storage.exists('takeover')) throw new RecoveryError(RECOVERY_MESSAGES.interruptedTakeover);
  };
  let claimDeleted = false;
  const claimBytes = await storage.exists('claim.json') ? await storage.read('claim.json') : undefined;
  let initialClaim: unknown;
  try { initialClaim = claimBytes === undefined ? undefined : JSON.parse(claimBytes.toString('utf8')); } catch { initialClaim = undefined; }
  if (claimToken !== null && (!isClaim(initialClaim) || initialClaim.token !== claimToken)) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
  if (claimToken === null && data?.outcome !== 'removing' && claimBytes !== undefined) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
  const check = async (): Promise<void> => {
    await assertActive?.();
    await checkIdentity();
    if (claimDeleted) return;
    const current = await storage.exists('claim.json') ? await storage.read('claim.json') : undefined;
    if (current === undefined ? claimBytes !== undefined : claimBytes === undefined || !current.equals(claimBytes)) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
  };
  await check();
  const contents = await inventory(storage, data);
  const finishMetadata = async (): Promise<void> => {
    await check(); await storage.unlink('.gitignore');
    await storage.boundary('removal:6');
    await check(); await storage.unlink('journal.json');
    await storage.boundary('removal:7');
    await check(); await storage.unlink('owner.json');
    await storage.boundary('removal:8');
    await storage.removeFolder();
    await storage.syncDirectory(storage.target.root);
    await storage.boundary('removal:9');
  };
  if (data === undefined && contents.root.every(name => ['owner.json', 'journal.json', '.gitignore'].includes(name))) {
    // A metadata tail needs only its remaining deletes. Recreating a journal
    // here would add a new crash state after the data and claim are gone.
    await finishMetadata();
    return;
  }
  if (data !== undefined) {
    data.outcome = 'removing';
    await storage.writeJson('journal.json', data, false, check);
  }
  await storage.boundary('removal:1');
  for (const [directory, entries] of [['backups', contents.backups], ['displaced', contents.displaced]] as const) {
    for (const name of entries) { await check(); await storage.unlink(`${directory}/${name}`); }
    await check(); await storage.rmdir(directory);
  }
  await storage.boundary('removal:2');
  for (const name of contents.root.filter((name) => isAbandoned(name) || isTemporary(name))) { await check(); await storage.unlink(name); }
  await storage.boundary('removal:3');
  await check(); await storage.unlink('claim.json');
  claimDeleted = true;
  await storage.boundary('removal:4');
  await storage.writeJson('journal.json', { outcome: 'removing', phase: 'metadata' }, false, check);
  await storage.boundary('removal:5');
  await finishMetadata();
}

/** Empty terminal cleanup and empty bootstrap are indistinguishable, so both require confirmation. */
export async function removeUninitialized(storage: Storage, stopped: boolean): Promise<void> {
  if (!stopped) throw new RecoveryError(RECOVERY_MESSAGES.stop);
  const root = await uninitializedEntries(storage);
  for (const name of root) {
    if (name === 'backups' || name === 'displaced') await storage.rmdir(name);
    else await storage.unlink(name);
  }
  await storage.removeFolder();
  await storage.syncDirectory(storage.target.root);
}

export async function uninitializedEntries(storage: Storage): Promise<string[]> {
  const root = await storage.list();
  for (const name of root) {
    if (name === 'takeover') throw new RecoveryError(RECOVERY_MESSAGES.interruptedTakeover);
    if (name === '.gitignore' || isTemporary(name)) {
      const info = await storage.fs.lstat(await storage.at(name));
      if (!info.isFile() || info.isSymbolicLink()) throw new RecoveryError(RECOVERY_MESSAGES.unrecognized);
    } else if ((name !== 'backups' && name !== 'displaced') || (await storage.list(name)).length !== 0) throw new RecoveryError(RECOVERY_MESSAGES.unrecognized);
  }
  return root;
}

export async function validateRemovalInventory(storage: Storage, data: Journal | undefined): Promise<void> { await inventory(storage, data); }
