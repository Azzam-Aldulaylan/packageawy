import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildManifestReconciliationArgs } from '../../out/core/upgrade/plan.js';
import { buildStagedManifest, buildStagedManifestForRemoval } from '../../out/core/upgrade/stagedManifest.js';
import { createNodeUpgradeTransactionFileAdapter } from '../../out/host/nodeUpgradeTransactionFiles.js';
import { runUpgradeTransaction } from '../../out/host/upgradeTransaction.js';

import {
  createRealProjectFixture,
  FIXTURE_BASELINE_VERSION,
  FIXTURE_DEPENDENCY,
  FIXTURE_DEV_DEPENDENCY,
  FIXTURE_TARGET_VERSION,
  installArgs,
  runCommand,
  runPackageManager,
} from './real-project-fixtures.mjs';

async function exactFiles(fixture) {
  return {
    manifest: await readFile(fixture.manifestPath),
    lockfile: await readFile(fixture.lockfilePath),
  };
}

async function installExecutor(packageManager, root) {
  try {
    const result = await runPackageManager(packageManager, installArgs(packageManager), root);
    return { status: 'succeeded', exitCode: result.exitCode };
  } catch (cause) {
    return { status: 'failed', code: 'PACKAGE_MANAGER_FAILED', message: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function verifyFixture(root, expectedVersion, shouldExist = true) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const declared = manifest.dependencies?.[FIXTURE_DEPENDENCY];
  if (shouldExist ? declared !== expectedVersion : declared !== undefined) {
    return {
      status: 'failed',
      checks: [{ id: 'manifest', status: 'failed', message: `Unexpected declaration: ${String(declared)}` }],
    };
  }
  if (shouldExist) {
    const installed = JSON.parse(
      await readFile(path.join(root, 'node_modules', FIXTURE_DEPENDENCY, 'package.json'), 'utf8')
    );
    if (installed.version !== expectedVersion) {
      return {
        status: 'failed',
        checks: [{ id: 'installed-version', status: 'failed', message: `Installed ${installed.version}` }],
      };
    }
    const command = process.execPath;
    const verification = await runCommand(command, ['verify.mjs'], { cwd: root, allowFailure: true });
    if (verification.exitCode !== 0) {
      return {
        status: 'failed',
        checks: [{ id: 'fixture-script', status: 'failed', message: verification.stderr || verification.stdout }],
      };
    }
  }
  return { status: 'passed', checks: [{ id: 'real-project', status: 'passed' }] };
}

async function resetFixture(fixture) {
  await writeFile(fixture.manifestPath, fixture.baselineManifest);
  await runPackageManager(fixture.packageManager, installArgs(fixture.packageManager), fixture.root);
  const current = await exactFiles(fixture);
  assert.deepEqual(current.manifest, fixture.baselineManifest);
}

async function runManager(packageManager) {
  const fixture = await createRealProjectFixture(packageManager);
  const metrics = { packageManager, setupMs: fixture.setupDurationMs };
  try {
    const allowlistedPaths = [fixture.manifestPath, fixture.lockfilePath];
    const files = await createNodeUpgradeTransactionFileAdapter({
      workspaceRoot: fixture.root,
      allowlistedPaths,
    });

    const upgradeManifest = buildStagedManifest(fixture.baselineManifest.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      target: FIXTURE_TARGET_VERSION,
      classification: 'prod',
    }]);
    let started = performance.now();
    const upgrade = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: fixture.baselineManifest,
        contents: Buffer.from(upgradeManifest),
      },
      install: { execute: () => installExecutor(packageManager, fixture.root) },
      verifier: { verify: () => verifyFixture(fixture.root, FIXTURE_TARGET_VERSION) },
    });
    metrics.upgradeMs = performance.now() - started;
    assert.equal(upgrade.completion, 'kept');
    assert.equal(upgrade.reason, 'verified');
    await resetFixture(fixture);

    const removalSource = await readFile(fixture.manifestPath);
    const removalManifest = buildStagedManifestForRemoval(removalSource.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      classification: 'prod',
    }]);
    started = performance.now();
    const removal = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: removalSource,
        contents: Buffer.from(removalManifest),
      },
      install: { execute: () => installExecutor(packageManager, fixture.root) },
      verifier: { verify: () => verifyFixture(fixture.root, FIXTURE_BASELINE_VERSION, false) },
    });
    metrics.removalMs = performance.now() - started;
    assert.equal(removal.completion, 'kept');
    assert.equal(removal.reason, 'verified');
    await resetFixture(fixture);

    const rollbackBefore = await exactFiles(fixture);
    const rollbackManifest = buildStagedManifest(rollbackBefore.manifest.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      target: FIXTURE_TARGET_VERSION,
      classification: 'prod',
    }]);
    started = performance.now();
    const rolledBack = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: rollbackBefore.manifest,
        contents: Buffer.from(rollbackManifest),
      },
      install: { execute: () => installExecutor(packageManager, fixture.root) },
      verifier: {
        verify: async () => ({
          status: 'failed',
          checks: [{ id: 'intentional-fixture-failure', status: 'failed', message: 'Rollback probe.' }],
        }),
      },
      verificationFailureDecider: { decide: async () => 'rollback' },
    });
    metrics.rollbackMs = performance.now() - started;
    assert.equal(rolledBack.completion, 'rolled-back');
    assert.equal(rolledBack.rollback.status, 'succeeded');
    const rollbackAfter = await exactFiles(fixture);
    assert.deepEqual(rollbackAfter.manifest, rollbackBefore.manifest);
    assert.deepEqual(rollbackAfter.lockfile, rollbackBefore.lockfile);
    await resetFixture(fixture);

    // A ~ declaration upgraded to a target below the newest matching version
    // keeps its operator and still resolves exactly the target: exact stage,
    // full install, then the declared range and a lockfile-only pass.
    const rangeSource = (await readFile(fixture.manifestPath, 'utf8'))
      .replace(`"${FIXTURE_DEV_DEPENDENCY}": "4.1.5"`, `"${FIXTURE_DEV_DEPENDENCY}": "~4.0.0"`);
    await writeFile(fixture.manifestPath, rangeSource);
    await runPackageManager(packageManager, installArgs(packageManager), fixture.root);
    const rangeChange = [{ packageName: FIXTURE_DEV_DEPENDENCY, target: '4.1.0', classification: 'dev' }];
    const rangeExact = buildStagedManifest(rangeSource, rangeChange);
    const rangeStyled = buildStagedManifest(rangeSource, rangeChange, { rangeStyle: 'preserve' });
    assert.equal(rangeStyled, rangeSource.replace('"kleur": "~4.0.0"', '"kleur": "~4.1.0"'));
    started = performance.now();
    const ranged = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: Buffer.from(rangeSource),
        contents: Buffer.from(rangeExact),
      },
      install: {
        execute: async () => {
          const first = await installExecutor(packageManager, fixture.root);
          if (first.status !== 'succeeded') return first;
          const swapped = await files.compareAndSwap(
            fixture.manifestPath,
            { exists: true, contents: Buffer.from(rangeExact) },
            { exists: true, contents: Buffer.from(rangeStyled) }
          );
          if (swapped !== 'restored') return { status: 'failed', code: 'CONFLICT', message: 'package.json changed.' };
          try {
            await runPackageManager(
              packageManager,
              buildManifestReconciliationArgs(packageManager, { ignoreScripts: true, lockfileOnly: true }),
              fixture.root
            );
            return { status: 'succeeded' };
          } catch (cause) {
            return { status: 'failed', code: 'PACKAGE_MANAGER_FAILED', message: String(cause) };
          }
        },
      },
    });
    metrics.rangeStyleMs = performance.now() - started;
    assert.equal(ranged.completion, 'kept');
    assert.equal(await readFile(fixture.manifestPath, 'utf8'), rangeStyled);
    const rangeLock = await readFile(fixture.lockfilePath, 'utf8');
    if (packageManager === 'npm') {
      const lock = JSON.parse(rangeLock);
      assert.equal(lock.packages[''].devDependencies.kleur, '~4.1.0');
      assert.equal(lock.packages['node_modules/kleur'].version, '4.1.0');
    } else {
      assert.match(rangeLock, /kleur:\s*\n\s*specifier: ~4\.1\.0\s*\n\s*version: 4\.1\.0\b/);
    }
    const installedKleur = JSON.parse(
      await readFile(path.join(fixture.root, 'node_modules', FIXTURE_DEV_DEPENDENCY, 'package.json'), 'utf8')
    );
    assert.equal(installedKleur.version, '4.1.0');
    await resetFixture(fixture);

    // The real reconciliation argv must update the lockfile even when a
    // project .npmrc says save=false, and a package declared in both
    // dependencies and devDependencies must install the target.
    const reconcile = async () => {
      try {
        await runPackageManager(
          packageManager,
          buildManifestReconciliationArgs(packageManager, { ignoreScripts: true }),
          fixture.root
        );
        return { status: 'succeeded' };
      } catch (cause) {
        return { status: 'failed', code: 'PACKAGE_MANAGER_FAILED', message: String(cause) };
      }
    };
    const assertResolvedTarget = async () => {
      const lock = await readFile(fixture.lockfilePath, 'utf8');
      if (packageManager === 'npm') {
        assert.equal(JSON.parse(lock).packages[`node_modules/${FIXTURE_DEPENDENCY}`].version, FIXTURE_TARGET_VERSION);
      } else {
        assert.match(lock, new RegExp(`${FIXTURE_DEPENDENCY}:\\s*\\n\\s*specifier: ${FIXTURE_TARGET_VERSION}\\s*\\n\\s*version: ${FIXTURE_TARGET_VERSION}\\b`));
      }
      const installed = JSON.parse(
        await readFile(path.join(fixture.root, 'node_modules', FIXTURE_DEPENDENCY, 'package.json'), 'utf8')
      );
      assert.equal(installed.version, FIXTURE_TARGET_VERSION);
    };
    const npmrcPath = path.join(fixture.root, '.npmrc');
    await writeFile(npmrcPath, 'save=false\n');
    try {
      const saveSource = await readFile(fixture.manifestPath);
      const saveManifest = buildStagedManifest(saveSource.toString('utf8'), [{
        packageName: FIXTURE_DEPENDENCY, target: FIXTURE_TARGET_VERSION, classification: 'prod',
      }], { rangeStyle: 'preserve' });
      const saved = await runUpgradeTransaction({
        allowlistedPaths,
        files,
        manifestStage: { path: fixture.manifestPath, expectedContents: saveSource, contents: Buffer.from(saveManifest) },
        install: { execute: reconcile },
      });
      assert.equal(saved.completion, 'kept');
      assert.equal(await readFile(fixture.manifestPath, 'utf8'), saveManifest);
      await assertResolvedTarget();
    } finally {
      await rm(npmrcPath, { force: true });
    }
    await resetFixture(fixture);

    const duplicateSource = (await readFile(fixture.manifestPath, 'utf8')).replace(
      `"${FIXTURE_DEV_DEPENDENCY}": "4.1.5"`,
      `"${FIXTURE_DEV_DEPENDENCY}": "4.1.5",\n    "${FIXTURE_DEPENDENCY}": "${FIXTURE_BASELINE_VERSION}"`
    );
    await writeFile(fixture.manifestPath, duplicateSource);
    await runPackageManager(packageManager, installArgs(packageManager), fixture.root);
    const duplicateManifest = buildStagedManifest(duplicateSource, [{
      packageName: FIXTURE_DEPENDENCY, target: FIXTURE_TARGET_VERSION, classification: 'prod',
    }], { rangeStyle: 'preserve' });
    assert.equal(
      duplicateManifest,
      duplicateSource.replaceAll(`"${FIXTURE_DEPENDENCY}": "${FIXTURE_BASELINE_VERSION}"`, `"${FIXTURE_DEPENDENCY}": "${FIXTURE_TARGET_VERSION}"`)
    );
    const duplicated = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: { path: fixture.manifestPath, expectedContents: Buffer.from(duplicateSource), contents: Buffer.from(duplicateManifest) },
      install: { execute: reconcile },
    });
    assert.equal(duplicated.completion, 'kept');
    await assertResolvedTarget();
    await resetFixture(fixture);

    const staleExpected = await readFile(fixture.manifestPath);
    const staleManifest = buildStagedManifest(staleExpected.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      target: FIXTURE_TARGET_VERSION,
      classification: 'prod',
    }]);
    const externalManifest = Buffer.from(`${staleExpected.toString('utf8').trimEnd()}\n\n`);
    await writeFile(fixture.manifestPath, externalManifest);
    let installCalled = false;
    const stale = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: staleExpected,
        contents: Buffer.from(staleManifest),
      },
      install: {
        execute: async () => {
          installCalled = true;
          return { status: 'succeeded' };
        },
      },
    });
    assert.equal(stale.completion, 'not-started');
    assert.equal(stale.reason, 'manifest-stage-failed');
    assert.equal(stale.manifestStage.status, 'failed');
    assert.equal(stale.manifestStage.code, 'CONFLICT');
    assert.equal(installCalled, false);
    assert.deepEqual(await readFile(fixture.manifestPath), externalManifest);

    for (const [name, duration] of Object.entries(metrics)) {
      if (name.endsWith('Ms')) assert.ok(duration < 120_000, `${packageManager} ${name} exceeded 120 seconds.`);
    }
    return metrics;
  } finally {
    await fixture.cleanup();
  }
}

const reports = [];
for (const packageManager of ['npm', 'pnpm']) reports.push(await runManager(packageManager));

console.log('Disposable real-project transaction results');
for (const report of reports) {
  console.log(
    `${report.packageManager}: setup ${report.setupMs.toFixed(0)} ms, upgrade ${report.upgradeMs.toFixed(0)} ms, ` +
    `removal ${report.removalMs.toFixed(0)} ms, rollback ${report.rollbackMs.toFixed(0)} ms, ` +
    `range style ${report.rangeStyleMs.toFixed(0)} ms`
  );
}

