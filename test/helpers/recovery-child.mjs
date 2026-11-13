import { prepareJournal } from '../../out/host/recovery/journal.js';
import { inspectRecovery } from '../../out/host/recovery/inspection.js';
import { RecoverySession } from '../../out/host/recovery/session.js';
import { normalizeBoundary, choices } from './recovery.mjs';
import { createRangePreservingInstall } from '../../out/host/rangePreservingInstall.js';
import { UpgradeExecutionSession } from '../../out/host/upgradeRunner.js';
import { runUpgradeTransaction } from '../../out/host/upgradeTransaction.js';
import { writeFile } from 'node:fs/promises';
const [targetJson, mode, pauseAt = '', claimJson = 'null'] = process.argv.slice(2);
const target = JSON.parse(targetJson);
// A pending Promise alone does not keep Node alive. Keep IPC referenced so
// each paused boundary waits for a real SIGKILL from the parent test.
process.on('message', () => {});
const finish = message => process.send?.(message, () => process.disconnect());
const occurrences = new Map();
const hooks = { async boundary(raw) {
  const name = normalizeBoundary(raw);
  const count = (occurrences.get(name) ?? 0) + 1;
  occurrences.set(name, count);
  const indexed = `${name}#${count}`;
  process.send?.({ boundary: indexed === pauseAt ? indexed : name, indexed });
  if (name === pauseAt || indexed === pauseAt) await new Promise(() => {});
} };
try {
  if (mode === 'prepare' || mode.startsWith('transaction:')) {
    const flow = mode.split(':')[1];
    const journal = await prepareJournal({ ...target, ...(flow ? { operation: flow } : {}) }, hooks);
    if (flow) {
      // Use the production runner for intent and completion around dispatch.
      // The fake process only supplies filesystem effects and a task result.
      const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true,
        runProcess: async request => {
          if (!request.title.startsWith('Packageawy: Verify')) await writeFile(target.allowlistedPaths[1], 'installed');
          return { onDidExit(listener) { const handle = setImmediate(() => listener(request.title.startsWith('Packageawy: Verify') ? 1 : 0)); return { dispose: () => clearImmediate(handle) }; } };
        },
      }, () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' }));
      session.journal = journal;
      const params = { cwd: target.root, ignoreScripts: true, packageManager: 'npm' };
      const prepared = flow === 'remediation' ? session.prepareLockfileReconciliation(params) : session.prepareManifestReconciliation({ ...params,
        ...(flow === 'upgrade' ? { taskTitle: 'Packageawy: Upgrade a' } : {}),
      });
      const restyle = session.prepareManifestReconciliation({ ...params, lockfileOnly: true, taskTitle: 'Packageawy: Upgrade a (keep version ranges)' });
      const stage = { path: target.allowlistedPaths[flow === 'remediation' ? 1 : 0],
        expectedContents: (await journal.files.read(target.allowlistedPaths[flow === 'remediation' ? 1 : 0])).contents, contents: Buffer.from('staged') };
      const result = await runUpgradeTransaction({ allowlistedPaths: target.allowlistedPaths, files: journal.adapter(), journal,
        ...(flow === 'remediation' ? { fileStages: [stage] } : { manifestStage: stage }),
        install: flow === 'upgrade' ? createRangePreservingInstall({ manifestPath: target.allowlistedPaths[0], stagedManifest: 'staged', styledManifest: 'styled',
          resolve: () => prepared.execute(), restyle: () => restyle.execute(),
        }) : { execute: async () => { const outcome = await prepared.execute(); return outcome.ok ? { status: 'succeeded' } : { status: 'failed' }; } },
        verifier: { verify: () => session.verify({ cwd: target.root, packageManager: 'npm', packageName: 'a', scripts: [{ id: 'test', scriptName: 'test' }] }) },
      });
      await journal.finish(result.completion, flow === 'cleanup');
      session.dispose();
    }
  } else if (mode === 'dismiss') {
    const inspected = await inspectRecovery(target);
    const session = await RecoverySession.open(target, true, inspected.view.claim, hooks);
    await session.dismiss(true, true);
  } else if (mode === 'restore') {
    const inspected = await inspectRecovery(target);
    const session = await RecoverySession.open(target, true, inspected.view.claim, hooks);
    await session.apply(choices(await session.presentation(), 'restore', true));
  } else if (mode === 'claim') {
    await RecoverySession.open(target, true, JSON.parse(claimJson), hooks);
  }
  finish({ done: true });
} catch (error) { finish({ error: error.message }); }
