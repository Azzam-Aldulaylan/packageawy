import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import io from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

import {
  buildLockfileMaterializationArgs,
  buildResolverArgs,
  buildTransitiveRemediationMaterializationArgs,
  IsolatedResolverVerifier,
  isolatedRelativePath,
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

test('pnpm resolver argv confines writes to temp and never enables lifecycle scripts or pnpmfiles', () => {
  assert.deepEqual(buildResolverArgs('pnpm', 'https://registry.npmjs.org', { strictPeerDeps: false, legacyPeerDeps: false }), [
    'install', '--ignore-scripts', '--ignore-pnpmfile', '--lockfile=false', '--loglevel=error', '--registry=https://registry.npmjs.org',
  ]);
  assert.deepEqual(buildLockfileMaterializationArgs('pnpm', 'https://registry.npmjs.org', { strictPeerDeps: false, legacyPeerDeps: false }), [
    'install', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile', '--loglevel=error', '--registry=https://registry.npmjs.org',
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

test('pnpm diagnostics sanitize controls, credentials and private paths before truncation', async () => {
  const secrets = ['url-user', 'url-password', 'bearer-secret', 'basic-secret', 'header-secret',
    'config-secret', 'password-secret', 'env-secret', 'query-secret', `npm_${'n'.repeat(36)}`, `ghp_${'g'.repeat(36)}`];
  const verifier = workspaceVerifier({}, {
    runner: { async run(_inv, _args, cwd) {
      return { exitCode: 1, stdout: `\n${homedir()}/private ${cwd}/package.json`, stderr: [
        '\x1b[31mERR_PNPM_PEER_DEP_ISSUES\x1b[0m',
        '\x1b]8;;https://hidden.example\x07visible\x1b]8;;\x1b\\',
        '\x1bPterminal payload\x1b\\\x9b2K\x00\x08',
        'https://url-user:url-password@registry.example/a?token=query-secret',
        'Authorization: Bearer bearer-secret',
        'Proxy-Authorization: Basic basic-secret',
        '"authorization": "Custom header-secret",',
        '//registry.example/:_authToken="config-secret"',
        '_password=password-secret NODE_AUTH_TOKEN=env-secret',
        `npm_${'n'.repeat(36)} ghp_${'g'.repeat(36)}`,
      ].join('\n') };
    } },
  });
  const result = await verifier.verify(workspaceProposal);
  assert.equal(result.status, 'conflict');
  for (const secret of secrets) assert.ok(!result.explanation.includes(secret), `leaked ${secret}`);
  assert.ok(!result.explanation.includes(homedir()));
  assert.doesNotMatch(result.explanation, /[\x00-\x1f\x7f-\x9f]|terminal payload|hidden\.example/);
  assert.match(result.explanation, /<home>/);
  assert.match(result.explanation, /<temporary-project>/);
  assert.ok(result.explanation.length <= 540);

  const boundary = workspaceVerifier({}, { runner: { async run() {
    return { exitCode: 1, stdout: '', stderr: `${'x'.repeat(480)} npm_${'s'.repeat(36)} end` };
  } } });
  assert.doesNotMatch((await boundary.verify(workspaceProposal)).explanation, /npm_s|s{10}/);
});

test('pnpm diagnostics redact credential variants and unparseable URL userinfo', async () => {
  for (const stderr of ['NPM_AUTH_TOKEN=opaqueSecret', 'npmAuthToken: opaqueSecret',
    'YARN_NPM_AUTH_TOKEN=opaqueSecret', 'npmAuthIdent=opaqueSecret', 'NPM_CONFIG__AUTH=opaqueSecret',
    '_auth="opaqueSecret"', 'Authorization = "Bearer opaqueSecret"', 'Bearer opaqueSecret',
    '//url-user:opaqueSecret@registry.example', 'https://url-user:opaqueSecret@[invalid',
    '\x1b[31m_authToken\x1b[0m=opaqueSecret']) {
    const verifier = workspaceVerifier({}, { runner: { async run() {
      return { exitCode: 1, stdout: '', stderr };
    } } });
    assert.doesNotMatch((await verifier.verify(workspaceProposal)).explanation, /opaqueSecret|url-user/, stderr);
  }
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

const workspaceLock = (joseVersion) => [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .: {}',
  '',
  '  apps/web:',
  '    dependencies:',
  "      '@acme/shared':",
  '        specifier: workspace:*',
  '        version: link:../../packages/shared',
  '      jose:',
  `        specifier: ${joseVersion}`,
  `        version: ${joseVersion}`,
  '',
  '  packages/shared: {}',
  '',
  'packages:',
  '',
  `  jose@${joseVersion}:`,
  '    resolution: {integrity: sha512-test}',
  '',
  'snapshots:',
  '',
  `  jose@${joseVersion}: {}`,
  '',
].join('\n');

const workspaceProposal = {
  requested: { packageName: 'jose', currentVersion: '5.9.6', targetVersion: '5.10.0', classification: 'prod' },
  changes: [{ packageName: 'jose', currentVersion: '5.9.6', targetVersion: '5.10.0', classification: 'prod' }],
};

function workspaceVerifier(observed, options = {}) {
  return new IsolatedResolverVerifier({
    packageManager: 'pnpm', packageManagerVersion: '9.15.1',
    invocation: { executable: '/trusted/pnpm', prefixArgs: [] },
    manifestText: JSON.stringify({ name: '@acme/web', dependencies: { '@acme/shared': 'workspace:*', jose: '5.9.6' } }),
    lockfile: { name: 'pnpm-lock.yaml', text: workspaceLock('5.9.6') },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    workspace: {
      importerId: 'apps/web',
      files: [
        { path: 'pnpm-workspace.yaml', text: "packages:\n  - 'apps/*'\n  - 'packages/*'\n" },
        { path: 'package.json', text: JSON.stringify({ name: 'acme', private: true }) },
        { path: 'packages/shared/package.json', text: JSON.stringify({ name: '@acme/shared' }) },
      ],
    },
    runner: {
      async run(_invocation, args, cwd) {
        const { readFile, readdir, writeFile } = await import('node:fs/promises');
        observed.args = args;
        observed.rootEntries = (await readdir(cwd)).sort();
        observed.workspaceYaml = await readFile(`${cwd}/pnpm-workspace.yaml`, 'utf8');
        observed.siblingManifest = JSON.parse(await readFile(`${cwd}/packages/shared/package.json`, 'utf8'));
        observed.memberManifest = JSON.parse(await readFile(`${cwd}/apps/web/package.json`, 'utf8'));
        observed.lockfileAtRoot = await readFile(`${cwd}/pnpm-lock.yaml`, 'utf8');
        if (args.includes('--lockfile-only')) await writeFile(`${cwd}/pnpm-lock.yaml`, workspaceLock('5.10.0'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    ...options,
  });
}

for (const method of ['verify', 'materializeResolvedGraph']) {
  for (const cancelAt of ['before staging', 'first mkdir', 'first write', 'last write']) {
    test(`${method} cancellation at ${cancelAt} stops staging and removes the temporary project`, async t => {
      const abort = new AbortController();
      const originals = { mkdtemp: io.mkdtemp, mkdir: io.mkdir, writeFile: io.writeFile };
      let tempRoot;
      let writes = 0;
      let directories = 0;
      let ran = false;
      const verifier = workspaceVerifier({}, { runner: { async run() {
        ran = true;
        return { exitCode: 1, stdout: '', stderr: '' };
      } } });
      io.mkdtemp = async (...args) => { tempRoot = await originals.mkdtemp(...args); return tempRoot; };
      io.mkdir = async (...args) => {
        directories += 1;
        await originals.mkdir(...args);
        if (cancelAt === 'first mkdir') abort.abort();
      };
      io.writeFile = async (...args) => {
        writes += 1;
        await originals.writeFile(...args);
        if (cancelAt === 'first write' || (cancelAt === 'last write' && writes === 5)) abort.abort();
      };
      syncBuiltinESMExports();
      t.after(() => { Object.assign(io, originals); syncBuiltinESMExports(); });
      if (cancelAt === 'before staging') abort.abort();
      if (method === 'verify') await assert.rejects(verifier[method](workspaceProposal, abort.signal), { name: 'AbortError' });
      else assert.deepEqual(await verifier[method](workspaceProposal, abort.signal), { ok: false });
      assert.equal(ran, false, 'the runner was invoked after cancellation');
      assert.equal(writes, cancelAt === 'last write' ? 5 : cancelAt === 'first write' ? 1 : 0);
      if (cancelAt === 'before staging' || cancelAt === 'first mkdir') assert.ok(directories <= 1);
      if (tempRoot !== undefined) await assert.rejects(io.stat(tempRoot), { code: 'ENOENT' });
    });
  }
}

test('a pnpm workspace member resolves inside a rebuilt workspace, so workspace: dependencies are found', async () => {
  const observed = {};
  const verifier = workspaceVerifier(observed, { retainResolvedGraph: true });
  const verification = await verifier.verify(workspaceProposal);
  assert.equal(verification.status, 'compatible');
  assert.deepEqual(observed.rootEntries, ['apps', 'package.json', 'packages', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
  assert.match(observed.workspaceYaml, /packages\/\*/);
  assert.equal(observed.siblingManifest.name, '@acme/shared');
  assert.equal(observed.memberManifest.dependencies.jose, '5.10.0');
  assert.equal(observed.memberManifest.dependencies['@acme/shared'], 'workspace:*');
  assert.equal(observed.lockfileAtRoot, workspaceLock('5.9.6'));
  assert.ok(observed.args.includes('--ignore-pnpmfile'));

  const materialized = await verifier.materializeResolvedGraph(workspaceProposal);
  assert.equal(materialized.ok, true);
  const jose = [...materialized.graph.nodes.values()].find((node) => node.name === 'jose' && node.direct);
  assert.equal(jose?.version, '5.10.0');
});

test('a pnpm workspace member keeps the lockfile when verifying, rather than a full fresh install', async () => {
  const observed = {};
  const verification = await workspaceVerifier(observed).verify(workspaceProposal);
  assert.equal(verification.status, 'compatible');
  assert.ok(observed.args.includes('--lockfile-only'));
  assert.ok(!observed.args.includes('--lockfile=false'));
});

test('the security materialization of a pnpm workspace member reads the member importer', async () => {
  const observed = {};
  const materialized = await workspaceVerifier(observed).materializeResolvedGraph(workspaceProposal);
  assert.equal(materialized.ok, true);
  const direct = [...materialized.graph.nodes.values()].filter((node) => node.direct).map((node) => node.name).sort();
  assert.deepEqual(direct, ['@acme/shared', 'jose']);
});

test('workspace paths that escape the temporary directory are refused', () => {
  const root = path.join(tmpdir(), 'root');
  for (const unsafe of ['../outside', 'apps/../../outside', '/etc', 'apps//web', './apps', 'C:/x', 'apps\\web', '']) {
    assert.throws(() => isolatedRelativePath(root, unsafe), /unsafe workspace path/);
  }
  assert.equal(isolatedRelativePath(root, 'apps/web'), path.join(root, 'apps', 'web'));
});

test('a workspace run that leaves the reviewed member out of the lockfile is not reported as compatible', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'pnpm', packageManagerVersion: '9.15.1',
    invocation: { executable: '/trusted/pnpm', prefixArgs: [] },
    manifestText: JSON.stringify({ name: '@acme/web', dependencies: { jose: '5.9.6' } }),
    lockfile: { name: 'pnpm-lock.yaml', text: workspaceLock('5.9.6') },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    retainResolvedGraph: true,
    workspace: { importerId: 'apps/web', files: [{ path: 'pnpm-workspace.yaml', text: '{"packages":[]}\n' }] },
    runner: {
      async run(_invocation, _args, cwd) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(`${cwd}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  const verification = await verifier.verify(workspaceProposal);
  assert.equal(verification.status, 'unknown');
  assert.equal(verification.code, 'RESOLVER_FAILED');
  assert.deepEqual(await verifier.materializeResolvedGraph(workspaceProposal), { ok: false });
});

test('a workspace that cannot be staged faithfully is unknown and never runs the package manager', async () => {
  let ran = false;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'pnpm', packageManagerVersion: '9.15.1',
    invocation: { executable: '/trusted/pnpm', prefixArgs: [] },
    manifestText: JSON.stringify({ name: '@acme/web', dependencies: { jose: '5.9.6' } }),
    lockfile: { name: 'pnpm-lock.yaml', text: workspaceLock('5.9.6') },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    retainResolvedGraph: true,
    workspace: { importerId: 'apps/web', files: [], unavailableReason: 'The workspace has more packages than the review can stage.' },
    runner: { async run() { ran = true; return { exitCode: 0, stdout: '', stderr: '' }; } },
  });
  const verification = await verifier.verify(workspaceProposal);
  assert.equal(verification.status, 'unknown');
  assert.match(verification.explanation, /more packages than the review can stage/);
  assert.deepEqual(await verifier.materializeResolvedGraph(workspaceProposal), { ok: false });
  assert.equal(ran, false);
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
