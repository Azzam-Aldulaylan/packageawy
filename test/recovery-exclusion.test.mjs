import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXCLUDED_DIRS, discoverProjectCandidates, isExcluded } from '../out/core/workspace/scan.js';
import { findSourceFiles, findConfigFiles, planWorkspaceFiles } from '../out/host/usage/workspaceFiles.js';
import { RpcPlatform } from '../out/host/platform/rpc/rpcPlatform.js';

const folder = { id: 'f', name: 'f', path: '/work' };
test('recovery data is excluded from discovery, source and usage scans', async () => {
  assert.ok(DEFAULT_EXCLUDED_DIRS.includes('.packageawy-recovery'));
  const candidates = discoverProjectCandidates([{ folderId: 'f', folderName: 'f', manifestPaths: ['package.json', '.packageawy-recovery/package.json', 'nested/.packageawy-recovery/backups/package.json'] }]);
  assert.deepEqual(candidates.map(candidate => candidate.manifestPath), ['package.json']);
  for (const path of ['.packageawy-recovery/file.ts', 'nested/.packageawy-recovery/backup.js']) assert.equal(isExcluded(path), true);
  const searches = [];
  const platform = { findFiles: async search => { searches.push(search); return []; } };
  const token = { isCancellationRequested: false };
  await findSourceFiles(platform, folder, '', 100, token);
  await findConfigFiles(platform, folder, '', token);
  assert.ok(searches.every(search => search.exclude.includes('.packageawy-recovery')));
  assert.deepEqual(planWorkspaceFiles(folder, ['/work/app.ts', '/work/.packageawy-recovery/backup.ts'], ['/work/.packageawy-recovery/vite.config.ts']), [
    { absolutePath: '/work/app.ts', filePath: 'app.ts', source: true, config: false },
  ]);
});

test('sidecar drops recovery watcher events before invoking invalidation callbacks', async () => {
  const listeners = new Map();
  const connection = { sendRequest: async () => null, sendNotification() {}, onNotification: (method, handler) => listeners.set(method, handler) };
  const platform = new RpcPlatform(connection, { workspaceFolders: [folder], isWorkspaceTrusted: true, settings: {}, workspaceState: {}, globalState: {} });
  const changed = [];
  platform.watchFiles('/work', '**/*', path => changed.push(path));
  const notify = listeners.get('files/didChange');
  for (const path of ['/work/.packageawy-recovery/journal.json', 'C:\\work\\.packageawy-recovery\\backups\\id.json', '/work/nested/.packageawy-recovery/displaced/id.bin']) notify({ watchId: 1, path });
  notify({ watchId: 1, path: '/work/package.json' });
  assert.deepEqual(changed, ['/work/package.json']);
});
