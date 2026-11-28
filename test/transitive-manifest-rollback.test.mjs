import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { makeCoordinator, makeProject, MANIFEST, lockfile } from './helpers/removal-project.mjs';
import { resolvedTarget } from './helpers/mutation-target.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';
import { manualReinstallNote } from '../out/host/manualReinstallCopy.js';
import { panel } from './helpers/dashboard-startup.mjs';
import { choices } from './helpers/recovery.mjs';

withoutFsync();

const summary = 'package.json changed while the fix was installing. Your edit was kept and the fix was not rolled back.';
const pnpmLock = 'lockfileVersion: \'9.0\'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^18.0.0\n        version: 18.2.0\n';

for (const packageManager of ['npm', 'pnpm']) {
  for (const installStatus of ['succeeded', 'failed']) {
    for (const [change, contents] of [
      ['valid edit', Buffer.from(MANIFEST.replace('fixture', 'user edit'))],
      ['dependency requirement edit', Buffer.from(MANIFEST.replace('^18.0.0', '^19.0.0'))],
      ['malformed JSON', Buffer.from('{"name":')],
      ['deleted manifest', null],
      ['added BOM', Buffer.from(`\uFEFF${MANIFEST}`)],
      ['CRLF edit', Buffer.from(MANIFEST.replaceAll('\n', '\r\n'))],
    ]) test(`${packageManager} transitive ${installStatus} install keeps ${change} and reports a manifest conflict`, async t => {
      const project = await makeProject(t);
      if (packageManager === 'pnpm') {
        await fs.rm(project.lockfilePath);
        project.lockfilePath = path.join(project.root, 'pnpm-lock.yaml');
        await fs.writeFile(project.lockfilePath, pnpmLock);
      }
      const beforeLock = packageManager === 'npm' ? lockfile(true) : pnpmLock;
      const proposedLock = beforeLock.replace('18.2.0', '18.3.1');
      let installStarted = false;
      let loadsAfterInstall = 0;
      const read = async () => {
        if (installStarted) loadsAfterInstall++;
        const manifestText = await fs.readFile(project.manifestPath, 'utf8');
        JSON.parse(manifestText);
        return {
          root: project.root, manifestText,
          lockfileText: await fs.readFile(project.lockfilePath, 'utf8'),
          lockfilePath: project.lockfilePath, lockfileName: path.basename(project.lockfilePath),
          registry: 'https://registry.npmjs.org/', resolvedRegistry: { defaultRegistry: 'https://registry.npmjs.org/', scopes: {} },
          packageManager, importerId: '.', mutationTarget: resolvedTarget(project.root, { packageManager }),
        };
      };
      const snapshot = await read();
      const f = makeCoordinator(project, {
        mutationRoot: () => project.root,
        loadProject: read,
        ensureController: async () => ({ root: project.root, upgradeSource: snapshot }),
      });
      f.coordinator.session.invocationResolver = () => ({ executable: 'node', prefixArgs: [`${packageManager}.js`], version: '10.0.0' });
      let installs = 0;
      f.coordinator.session.prepareLockfileReconciliation = async () => ({
        ok: true,
        async execute() {
          installs++;
          installStarted = true;
          assert.equal(await fs.readFile(project.lockfilePath, 'utf8'), proposedLock);
          if (contents === null) await fs.rm(project.manifestPath);
          else await fs.writeFile(project.manifestPath, contents);
          // The current lockfile can differ from both the snapshot and the reviewed fix.
          await fs.writeFile(project.lockfilePath, 'current lockfile');
          return installStatus === 'succeeded' ? { ok: true }
            : { ok: false, status: 'failed', code: 'INSTALL_FAILED', message: 'Install failed.' };
        },
      });
      f.coordinator.remediationPlans.set('plan', {
        id: 'plan', packageName: 'react', snapshot, before: {}, targetAdvisories: [],
        proposedLockfileText: proposedLock, packageManagerVersion: null, ignoreScripts: true,
        verificationScripts: [], suggestedScriptNames: [], plan: { automaticApplyAllowed: true, target: { resolved: [] } },
        presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} },
        expiresAt: Date.now() + 60_000, stale: false,
      });
      await f.coordinator.handleConfirmRemediation({ analysisId: 'plan' });
      assert.equal(installs, 1);
      if (contents === null) await assert.rejects(fs.readFile(project.manifestPath), { code: 'ENOENT' });
      else assert.deepEqual(await fs.readFile(project.manifestPath), contents);
      assert.equal(await fs.readFile(project.lockfilePath, 'utf8'), 'current lockfile');
      const result = f.messages.findLast(message => message.status === 'remediation-apply-result')?.result;
      assert.ok(result, JSON.stringify(f.messages));
      assert.equal(result.outcome, 'recovery-required');
      assert.equal(result.rollback, 'conflict');
      assert.equal(result.verification, installStatus === 'succeeded' ? 'failed' : 'not-run');
      assert.equal(result.message, `${summary} ${manualReinstallNote(packageManager)}`);
      assert.deepEqual(f.prompts, []);
      assert.equal(loadsAfterInstall, 0, 'raw byte comparison and the early conflict must precede project parsing');
      const held = f.coordinator.reservation.held;
      assert.equal(held.state, 'retained');
      assert.equal(held.journal.data.outcome, 'rollback-incomplete');
      assert.deepEqual(await fs.readdir(path.join(project.root, '.packageawy-recovery/displaced')), []);
      assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
    });
  }
}

for (const installStatus of ['succeeded', 'failed']) {
  for (const change of ['malformed', 'deleted']) test(`dashboard keeps ${change} manifest conflict after ${installStatus} install until recovery releases refreshes`, async t => {
    const project = await makeProject(t);
    const s = await panel(t, { workspace: project.root, projects: ['.'], target: '.', early: false });
    await fs.writeFile(project.manifestPath, MANIFEST);
    await fs.writeFile(project.lockfilePath, lockfile(true));
    s.gate.resolve();
    await s.ready();
    const coordinator = s.current.upgradeCoordinator;
    const controller = s.current.controller;
    const snapshot = { root: controller.root, ...controller.upgradeSource };
    const proposedLock = snapshot.lockfileText.replace('18.2.0', '18.3.1');
    let mutated = false;
    let readsAfterMutation = 0;
    const load = s.current.loadProjectMeasured.bind(s.current);
    s.current.loadProjectMeasured = (...args) => {
      if (mutated) readsAfterMutation++;
      return load(...args);
    };
    s.platform.showModalWarning = async () => undefined;
    coordinator.session.invocationResolver = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
    coordinator.session.prepareLockfileReconciliation = async () => ({
      ok: true,
      async execute() {
        if (change === 'deleted') await fs.rm(project.manifestPath);
        else await fs.writeFile(project.manifestPath, '{"dependencies":');
        mutated = true;
        if (installStatus === 'failed') {
          const watcher = s.watchers.findLast(w => !w.disposed && w.glob === 'package.json');
          assert.ok(watcher);
          watcher.listener(project.manifestPath);
          await s.current.fileChangeCoordinator.flushAll();
        }
        return installStatus === 'succeeded' ? { ok: true }
          : { ok: false, status: 'failed', code: 'INSTALL_FAILED', message: 'Install failed.' };
      },
    });
    coordinator.remediationPlans.set('plan', {
      id: 'plan', packageName: 'react', snapshot, before: {}, targetAdvisories: [],
      proposedLockfileText: proposedLock, packageManagerVersion: null, ignoreScripts: true,
      verificationScripts: [], suggestedScriptNames: [], plan: { automaticApplyAllowed: true, target: { resolved: [] } },
      presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} },
      expiresAt: Date.now() + 60_000, stale: false,
    });
    const start = s.posted.length;
    await s.current.handle({ type: 'confirm-remediation', analysisId: 'plan' });
    const result = s.posted.findLast(m => m.status === 'remediation-apply-result')?.result;
    assert.equal(result?.outcome, 'recovery-required', JSON.stringify(s.posted.slice(start)));
    assert.equal(result.rollback, 'conflict');
    assert.equal(result.message, `${summary} ${manualReinstallNote('npm')}`);
    assert.equal(coordinator.reservation.held.state, 'retained');
    assert.equal(s.current.controller, controller);
    assert.equal(controller.isEligible(), false);
    assert.equal(s.snapshots().at(-1).status, 'stale');
    assert.equal(s.current.fileChangeCoordinator.hasDeferred || s.current.fileChangeCoordinator.hasPending, true);

    // A late editor event, manual refresh and timer tick must keep recovery visible.
    s.watchers.findLast(w => !w.disposed && w.glob === 'package.json').listener(project.manifestPath);
    await s.current.fileChangeCoordinator.flushAll();
    await s.refresh();
    s.current.onBackgroundTick();
    await coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
    assert.equal(readsAfterMutation, 0);
    assert.equal(s.posted.slice(start).some(m => m.status === 'fatal-error'), false);
    assert.equal(s.posted.findLast(m => m.status === 'remove-error')?.error.code, 'REVALIDATING');
    assert.equal(coordinator.isMutationBusy(), true);
    const recovery = s.posted.findLast(m => m.status === 'recovery').recovery;
    assert.equal(recovery.state, 'incomplete');
    await coordinator.recovery.start(true, recovery.claim);
    const view = s.posted.findLast(m => m.status === 'recovery').recovery;
    await coordinator.recovery.apply(choices(view, 'restore'));
    await coordinator.recovery.dismiss(true, false);
    assert.equal(coordinator.isMutationBusy(), false);
    assert.ok(readsAfterMutation > 0, 'recovery release must drain the queued real disk reload');
    assert.equal(await fs.readFile(project.manifestPath, 'utf8'), MANIFEST);
    assert.equal(controller.isEligible(), true);
    assert.equal(s.posted.slice(start).some(m => m.status === 'fatal-error'), false);
  });
}
