import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';

for (const scenario of ['workspace root', 'workspace member', 'standalone']) {
  test(`upgrade and staged-removal execution target the ${scenario}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'packageawy-pnpm-workspace-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (scenario !== 'standalone') await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
    const cwd = scenario === 'workspace member' ? path.join(root, 'packages', 'app') : root;
    await mkdir(cwd, { recursive: true });
    const requests = [];
    const session = new UpgradeExecutionSession({
      isWorkspaceTrusted: () => true,
      async runProcess(request) {
        requests.push(request);
        return { onDidExit(callback) { queueMicrotask(() => callback(0)); return { dispose() {} }; } };
      },
    });
    t.after(() => session.dispose());
    // Keep tool discovery offline while exercising the real argument and process wiring.
    session.resolveInvocation = () => ({ executable: '/trusted/pnpm', prefixArgs: [] });
    const importerId = scenario === 'workspace member' ? 'packages/app' : '.';
    for (const packageManager of ['npm', 'pnpm']) {
      for (const coordinatedChanges of [undefined, [
        { packageName: 'pkg', target: '2.0.0', classification: 'prod' },
        { packageName: 'other', target: '2.0.0', classification: 'prod' },
      ]]) {
        assert.deepEqual(await session.run({
          cwd, importerId, packageManager, packageName: 'pkg', currentVersion: '1.0.0',
          target: '2.0.0', classification: 'prod', ignoreScripts: true, coordinatedChanges,
        }), { ok: true });
      }
      const removal = session.prepareManifestReconciliation({ cwd, importerId, packageManager, ignoreScripts: true });
      assert.equal(removal.ok, true);
      assert.deepEqual(await removal.execute(), { ok: true });
      for (const request of requests.splice(0)) {
        assert.equal(request.cwd, cwd);
        assert.equal(request.args.includes('-w'), packageManager === 'pnpm' && scenario === 'workspace root');
        assert.equal(request.args.includes('--filter'), false, 'members execute in their own directory');
      }
    }
  });
}

test('pnpm discovery failure is returned and shown with actionable search guidance', async () => {
  const shown = [];
  const session = new UpgradeExecutionSession({
    isWorkspaceTrusted: () => true,
    showErrorMessage: (message) => shown.push(message),
  });
  session.resolveInvocation = () => null;
  const result = await session.run({ cwd: '/project', packageManager: 'pnpm' });
  assert.equal(result.code, 'PACKAGE_MANAGER_NOT_FOUND');
  assert.match(result.message, /PATH.*PNPM_HOME.*installation folders.*login-shell/);
  assert.match(result.message, /Install pnpm or set PNPM_HOME/);
  assert.equal(shown[0], result.message);
  session.dispose();
});
