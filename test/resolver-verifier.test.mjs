import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLockfileMaterializationArgs,
  buildResolverArgs,
  buildTransitiveRemediationMaterializationArgs,
  IsolatedResolverVerifier,
} from '../out/host/resolverVerifier.js';

const proposal = {
  requested: { packageName: 'react', currentVersion: '18.0.0', targetVersion: '19.0.0', classification: 'prod' },
  changes: [{ packageName: 'react', currentVersion: '18.0.0', targetVersion: '19.0.0', classification: 'prod' }],
};

test('npm resolver argv is fixed, script-free, lockfile-free, and policy-aware', () => {
  assert.deepEqual(buildResolverArgs('npm', 'https://registry.npmjs.org', { strictPeerDeps: true, legacyPeerDeps: false }), [
    'install', '--dry-run', '--ignore-scripts', '--package-lock=false', '--audit=false', '--fund=false', '--json',
    '--registry=https://registry.npmjs.org', '--strict-peer-deps',
  ]);
});

test('pnpm resolver argv confines writes to temp and never enables lifecycle scripts', () => {
  assert.deepEqual(buildResolverArgs('pnpm', 'https://registry.npmjs.org', { strictPeerDeps: false, legacyPeerDeps: false }), [
    'install', '--ignore-scripts', '--lockfile=false', '--reporter=silent', '--registry=https://registry.npmjs.org',
  ]);
});

test('scoped registries become sorted --@scope:registry flags and invalid entries are skipped', () => {
  const policy = { strictPeerDeps: false, legacyPeerDeps: false };
  const scoped = {
    '@zeta': 'https://npm.zeta.example/',
    '@company': 'https://user:secret@npm.company.example/',
    '@evil --registry=https://attacker.example': 'https://npm.company.example/',
    '@bad': 'https://npm.company.example/ --ignore-scripts=false',
    '@file': 'file:///etc/passwd',
    '@-dash': 'https://npm.company.example/',
  };
  const expected = ['--@company:registry=https://npm.company.example/', '--@zeta:registry=https://npm.zeta.example/'];
  for (const manager of ['npm', 'pnpm']) {
    for (const args of [
      buildResolverArgs(manager, 'https://registry.npmjs.org', policy, scoped),
      buildLockfileMaterializationArgs(manager, 'https://registry.npmjs.org', policy, scoped),
      buildTransitiveRemediationMaterializationArgs(manager, ['minimatch'], 'https://registry.npmjs.org', policy, scoped),
    ]) {
      const registryIndex = args.indexOf('--registry=https://registry.npmjs.org');
      assert.ok(registryIndex >= 0);
      assert.deepEqual(args.slice(registryIndex + 1, registryIndex + 3), expected);
      assert.deepEqual(args.filter((arg) => arg.includes(':registry=')), expected);
      assert.ok(!args.some((arg) => arg.includes('secret') || arg.includes('attacker') || arg.includes('file:')));
    }
  }
});

test('isolated verifier rewrites only its temporary manifest and reports resolver success', async () => {
  let observed;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm',
    packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    registry: 'https://registry.npmjs.org',
    policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(invocation, args, cwd) {
        const { readFile } = await import('node:fs/promises');
        observed = { invocation, args, cwd, manifest: JSON.parse(await readFile(`${cwd}/package.json`, 'utf8')) };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  const result = await verifier.verify(proposal);
  assert.equal(result.status, 'compatible');
  assert.equal(observed.manifest.dependencies.react, '19.0.0');
  assert.deepEqual(observed.invocation, { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] });
});

test('isolated verifier uses the same classified mixed manifest as real reconciliation', async () => {
  let observedManifest;
  const mixedProposal = {
    requested: proposal.requested,
    changes: [
      proposal.changes[0],
      { packageName: 'typescript', currentVersion: '5.0.0', targetVersion: '6.0.0', classification: 'dev' },
    ],
  };
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'pnpm',
    packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/pnpm.cjs'] },
    manifestText: JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }),
    registry: 'https://registry.npmjs.org',
    policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, _args, cwd) {
        const { readFile } = await import('node:fs/promises');
        observedManifest = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  assert.equal((await verifier.verify(mixedProposal)).status, 'compatible');
  assert.equal(observedManifest.dependencies.react, '19.0.0');
  assert.equal(observedManifest.devDependencies.typescript, '6.0.0');
});

test('resolver stages shadow declarations at the target, as the real upgrade does', async () => {
  let observedManifest;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { react: '^17.0.0' },
    }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, _args, cwd) {
        const { readFile } = await import('node:fs/promises');
        observedManifest = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  await verifier.verify(proposal);
  assert.equal(observedManifest.dependencies.react, '19.0.0');
  assert.equal(observedManifest.devDependencies.react, '19.0.0');
});

test('peer resolver failures are conflicts and temporary paths are redacted and bounded', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run(_inv, _args, cwd) { return { exitCode: 1, stdout: '', stderr: `ERESOLVE peer dependency at ${cwd}\n${'x'.repeat(1000)}` }; } },
  });
  const result = await verifier.verify(proposal);
  assert.equal(result.status, 'conflict');
  assert.match(result.explanation, /<temporary-project>/);
  assert.ok(result.explanation.length <= 540);
});

test('non-peer process failures remain unknown rather than fabricated conflicts', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run() { return { exitCode: 1, stdout: '', stderr: 'network unavailable' }; } },
  });
  assert.equal((await verifier.verify(proposal)).status, 'unknown');
});

// -------------------------------------------- materializeResolvedGraph (transitive remediation)

test('materializeResolvedGraph with an empty changes proposal stages the manifest completely unchanged, the "fresh resolve, no version bump" analysis case', async () => {
  const manifestText = JSON.stringify({ dependencies: { 'sockjs-client': '^1.6.1' } }, null, 2);
  let observedManifestText;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, args, cwd) {
        const { readFile, writeFile } = await import('node:fs/promises');
        observedManifestText = await readFile(`${cwd}/package.json`, 'utf8');
        if (args.includes('--package-lock-only')) {
          await writeFile(
            `${cwd}/package-lock.json`,
            JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/sockjs-client': { version: '1.6.1' } } })
          );
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  const emptyProposal = {
    requested: { packageName: 'sockjs-client', currentVersion: '1.6.1', targetVersion: '1.6.1', classification: 'prod' },
    changes: [],
  };
  const result = await verifier.materializeResolvedGraph(emptyProposal);
  assert.equal(result.ok, true);
  // Byte-identical: buildStagedManifest (which always reformats/pins) was never invoked.
  assert.equal(observedManifestText, manifestText);
  assert.equal(result.graph.nodes.get('node_modules/sockjs-client').version, '1.6.1');
});

test('materializeResolvedGraph with real changes still stages the pinned manifest, same as verify()', async () => {
  let observedManifest;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, args, cwd) {
        const { readFile, writeFile } = await import('node:fs/promises');
        observedManifest = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'));
        if (args.includes('--package-lock-only')) {
          await writeFile(`${cwd}/package-lock.json`, JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  const result = await verifier.materializeResolvedGraph(proposal);
  assert.equal(result.ok, true);
  assert.equal(observedManifest.dependencies.react, '19.0.0');
});

test('materializeResolvedGraph degrades to ok:false on a non-zero resolver exit, never a fabricated graph', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run() { return { exitCode: 1, stdout: '', stderr: 'ENETUNREACH' }; } },
  });
  const emptyProposal = {
    requested: { packageName: 'react', currentVersion: '18.0.0', targetVersion: '18.0.0', classification: 'prod' },
    changes: [],
  };
  const result = await verifier.materializeResolvedGraph(emptyProposal);
  assert.deepEqual(result, { ok: false });
});

test('materializeResolvedGraph degrades to ok:false when the resolver exits cleanly but writes no parseable lockfile', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run() { return { exitCode: 0, stdout: '', stderr: '' }; } }, // no lockfile ever written
  });
  const emptyProposal = {
    requested: { packageName: 'react', currentVersion: '18.0.0', targetVersion: '18.0.0', classification: 'prod' },
    changes: [],
  };
  const result = await verifier.materializeResolvedGraph(emptyProposal);
  assert.deepEqual(result, { ok: false });
});

test('targeted transitive remediation starts from the active lockfile and returns exact proposed bytes', async () => {
  const manifestText = JSON.stringify({ dependencies: { 'sockjs-client': '1.6.1' } });
  const currentLockfile = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { 'sockjs-client': '1.6.1' } },
      'node_modules/sockjs-client': { version: '1.6.1', dependencies: { 'faye-websocket': '^0.11.3' } },
      'node_modules/faye-websocket': { version: '0.11.3', dependencies: { 'websocket-driver': '>=0.5.1' } },
      'node_modules/websocket-driver': { version: '0.7.3' },
    },
  });
  const proposedLockfile = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { 'sockjs-client': '1.6.1' } },
      'node_modules/sockjs-client': { version: '1.6.1', dependencies: { 'faye-websocket': '^0.11.3' } },
      'node_modules/faye-websocket': { version: '0.11.3', dependencies: { 'websocket-driver': '>=0.5.1' } },
      'node_modules/websocket-driver': { version: '0.7.5' },
    },
  });
  let observedArgs;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '11.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    lockfile: { name: 'package-lock.json', text: currentLockfile },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: true, legacyPeerDeps: false },
    runner: {
      async run(_invocation, args, cwd) {
        const { writeFile } = await import('node:fs/promises');
        observedArgs = args;
        await writeFile(`${cwd}/package-lock.json`, proposedLockfile);
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    },
  });

  const result = await verifier.materializeTransitiveRemediation(['websocket-driver']);
  assert.equal(result.ok, true);
  assert.equal(result.lockfileText, proposedLockfile);
  assert.equal(result.beforeGraph.nodes.get('node_modules/websocket-driver').version, '0.7.3');
  assert.equal(result.graph.nodes.get('node_modules/websocket-driver').version, '0.7.5');
  assert.deepEqual(observedArgs, buildTransitiveRemediationMaterializationArgs(
    'npm',
    ['websocket-driver'],
    'https://registry.npmjs.org',
    { strictPeerDeps: true, legacyPeerDeps: false }
  ));
});

test('targeted transitive remediation refuses a package-manager manifest mutation', async () => {
  const manifestText = JSON.stringify({ dependencies: { 'sockjs-client': '1.6.1' } });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { dependencies: { 'sockjs-client': '1.6.1' } }, 'node_modules/sockjs-client': { version: '1.6.1' } },
  });
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '11.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    lockfile: { name: 'package-lock.json', text: lockfileText },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, _args, cwd) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(`${cwd}/package.json`, JSON.stringify({ dependencies: { 'sockjs-client': '1.6.2' } }));
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    },
  });

  const result = await verifier.materializeTransitiveRemediation(['websocket-driver']);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpectedly changed package\.json/);
});

test('materializeResolvedGraph reads back the npm-shrinkwrap.json it staged, not a package-lock.json', async () => {
  const manifestText = JSON.stringify({ dependencies: { 'left-pad': '^1.3.0' } }, null, 2);
  const shrinkwrap = (version) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/left-pad': { version } } });
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    lockfile: { name: 'npm-shrinkwrap.json', text: shrinkwrap('1.2.0') },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, _args, cwd) {
        const { writeFile } = await import('node:fs/promises');
        // npm updates the shrinkwrap in place and writes no package-lock.json.
        await writeFile(`${cwd}/npm-shrinkwrap.json`, shrinkwrap('1.3.0'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  const result = await verifier.materializeResolvedGraph({
    requested: { packageName: 'left-pad', currentVersion: '1.2.0', targetVersion: '1.2.0', classification: 'prod' },
    changes: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.graph.nodes.get('node_modules/left-pad').version, '1.3.0');
});
