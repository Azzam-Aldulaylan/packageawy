import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { panel, until } from './helpers/dashboard-startup.mjs';

for (const [file, content] of [['doc.mdx', '# New document'], ['style.scss', '@use "only-here";']]) {
  for (const event of ['create', 'change', 'delete']) {
    test(`${event} ${file} revokes cached usage and a real open removal plan synchronously`, async t => {
      const s = await panel(t);
      await s.prepared();
      s.gate.resolve();
      await s.ready();
      const usage = s.current.usageCoordinator;
      await until(() => s.posted.some(message => message.status === 'cleanup-result' && message.findings.length > 0));
      await usage.handleWhereUsed({ package: 'clean-pkg' });
      assert.equal(s.posted.findLast(message => message.status === 'usage-result').analysis.fromCache, true);
      await usage.handleAnalyzeRemovalImpact({ requestId: 'impact', packages: ['clean-pkg'] });
      const guard = usage.smartCleanupRemovalEvidence('impact', ['clean-pkg']);
      assert.ok(guard);
      await s.current.upgradeCoordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'plan', removalRequestId: 'impact', packages: ['clean-pkg'] });
      const removal = s.posted.findLast(message => message.status === 'remove-analysis');
      assert.ok(removal, JSON.stringify(s.posted.filter(message => message.status === 'remove-error')));
      const absolutePath = path.join(s.root, 'a', file);
      if (event === 'delete') {
        await writeFile(absolutePath, content);
        await rm(absolutePath);
      } else {
        if (event === 'change') await writeFile(absolutePath, 'old');
        await writeFile(absolutePath, content);
      }
      const sourceWatcher = s.watchers.findLast(watcher => watcher.glob.includes('**/*.{js'));
      assert.ok(path.matchesGlob(file, sourceWatcher.glob), 'coverage inputs must use the real usage watcher');
      const before = s.posted.length;
      sourceWatcher.listener(absolutePath);
      assert.equal(guard.isCurrent(), false);
      const messages = s.posted.slice(before);
      assert.equal(messages.find(message => message.status === 'usage-error').error.code, 'STALE_SOURCE');
      assert.equal(messages.find(message => message.status === 'removal-impact-error').requestId, 'impact');
      assert.equal(messages.find(message => message.status === 'remove-error').error.code, 'STALE_SOURCE');
      assert.equal(s.current.upgradeCoordinator.removal, undefined);
      assert.equal(usage.smartCleanupRemovalEvidence('impact', ['clean-pkg']), null);
    });
  }
}
