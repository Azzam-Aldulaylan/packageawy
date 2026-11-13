import assert from 'node:assert/strict';
import io from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { rollbackFixture } from './optional-reinstall.mjs';
import { panel } from './dashboard-startup.mjs';
import { lockfile } from './removal-project.mjs';

export async function completedFixture(t, operation, fallback = false) {
  const f = await rollbackFixture(t, operation);
  f.state.installExitCode = 0;
  const run = f.coordinator.options.platform.runProcess;
  f.coordinator.options.platform.runProcess = async request => {
    const result = await run(request);
    if (operation === 'upgrade' && request.args.includes('install')) {
      await io.writeFile(f.project.lockfilePath, lockfile(true).replaceAll('^18.0.0', '^18.3.0').replaceAll('18.2.0', '18.3.0'));
    }
    return result;
  };
  const files = [f.project.manifestPath, f.project.lockfilePath];
  const saved = await Promise.all(files.map(file => io.readFile(file)));
  const s = await panel(t, { workspace: f.project.root, projects: ['.'], target: '.', early: false });
  await Promise.all(files.map((file, index) => io.writeFile(file, saved[index])));
  s.gate.resolve();
  await s.ready();
  assert.equal(s.snapshots().at(-1).data.rows.find(row => row.name === 'react').current, '18.2.0');
  for (const key of ['reloadFinalState', 'reloadSmartCleanupFinalState', 'readAndApplyMutationLocalState', 'refreshMutationEnrichmentInBackground', 'invalidateSnapshot']) {
    f.coordinator.options[key] = s.current.upgradeCoordinator.options[key];
  }
  if (fallback) {
    delete f.coordinator.options.readAndApplyMutationLocalState;
    delete f.coordinator.options.refreshMutationEnrichmentInBackground;
  }
  return { ...f, s, operation };
}

export function fault(t, f, code, { fallback = false } = {}) {
  let refreshing = false, reloading = false, remaining = 1, hits = 0;
  const load = f.s.current.loadProjectMeasured.bind(f.s.current);
  f.s.current.loadProjectMeasured = async (...args) => {
    reloading = true;
    try { return await load(...args); } finally { reloading = false; }
  };
  const refresh = f.coordinator.refreshAfterCompletion.bind(f.coordinator);
  f.coordinator.refreshAfterCompletion = read => refresh(async () => {
    refreshing = true;
    try { return await read(); } finally { refreshing = false; }
  });
  const original = io.readFile;
  io.readFile = async (file, ...args) => {
    // Fallback upgrade first reads local evidence through its independent
    // loader, then invokes the panel's full reload. Fail that second phase.
    if (String(file) === f.project.manifestPath && (!fallback || reloading)) {
      if (refreshing && remaining > 0) {
        remaining--;
        hits++;
        throw Object.assign(new Error(`post-completion manifest ${code}`), { code });
      }
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { io.readFile = original; syncBuiltinESMExports(); });
  return { reached: () => assert.equal(hits, 1, 'must fault the real post-completion read') };
}

