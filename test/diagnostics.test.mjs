import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnosticLine, isAuditUnavailableReason, isVersionListFailure, registryHost, safePackageName,
  versionListFailureFromEligibility, versionListFailureFromFetch, versionListFailureNeedsRefresh, versionListFailureText,
} from '../out/core/diagnostics.js';

test('fetch codes map to version list failures, http registries get their own reason', () => {
  assert.equal(versionListFailureFromFetch('TIMEOUT'), 'timeout');
  assert.equal(versionListFailureFromFetch('REGISTRY_5XX'), 'registry-error');
  assert.equal(versionListFailureFromFetch('REGISTRY_AUTH_REQUIRED'), 'sign-in');
  assert.equal(versionListFailureFromFetch('PARSE_ERROR'), 'bad-data');
  assert.equal(versionListFailureFromFetch('BAD_URL', 'http://npm.corp.example/'), 'insecure-registry');
  assert.equal(versionListFailureFromFetch('BAD_URL', 'https://npm.corp.example/'), 'unknown');
  assert.equal(versionListFailureFromFetch('SomethingElse'), 'unknown');
});

test('eligibility rejections map to project-changed or no-upgrade', () => {
  for (const reason of ['revalidating', 'stale-target', 'no-scan-result']) {
    assert.equal(versionListFailureFromEligibility(reason), 'project-changed');
  }
  assert.equal(versionListFailureFromEligibility('NO_ELIGIBLE_UPGRADE'), 'no-upgrade');
  assert.equal(versionListFailureNeedsRefresh('project-changed'), true);
  assert.equal(versionListFailureNeedsRefresh('timeout'), false);
});

test('texts name only the registry host, never paths, queries or credentials', () => {
  const url = 'https://user:secret@npm.corp.example/repo/token-abc123/?auth=xyz';
  for (const failure of ['timeout', 'network', 'registry-error', 'sign-in', 'rate-limited', 'not-found', 'bad-data',
    'insecure-registry', 'project-changed', 'no-upgrade', 'unknown']) {
    assert.ok(isVersionListFailure(failure));
    const text = versionListFailureText(failure, url);
    assert.doesNotMatch(text, /secret|token-abc123|auth=|user|\/repo/);
  }
  assert.equal(versionListFailureText('timeout', url), 'Could not reach npm.corp.example in time.');
  assert.equal(registryHost('not a url'), undefined);
});

test('log lines carry an allowlisted code, safe package name and host only', () => {
  assert.equal(diagnosticLine({ area: 'version-list', code: 'TIMEOUT', packageName: '@react-router/dev',
    registryUrl: 'https://registry.npmjs.org/' }), 'version-list: @react-router/dev via registry.npmjs.org failed (TIMEOUT)');
  const hostile = diagnosticLine({ area: 'update-check', code: 'bad code: https://x/?t=1', packageName: '../../etc/passwd',
    registryUrl: 'https://a:b@host.example/path?token=1' });
  assert.equal(hostile, 'update-check: via host.example failed (UNKNOWN)');
  assert.equal(safePackageName('x'.repeat(215)), undefined);
  assert.equal(diagnosticLine({ area: 'registry-cache', code: 'PARSE_ERROR', detail: 'recovered' }),
    'registry-cache: failed (PARSE_ERROR, recovered)');
});

test('audit reasons validate', () => {
  for (const reason of ['no-lockfile', 'npm-not-found', 'timeout', 'failed']) assert.ok(isAuditUnavailableReason(reason));
  assert.equal(isAuditUnavailableReason('other'), false);
});

test('the coordinator and controller log through diagnosticLine', async () => {
  const { readFile } = await import('node:fs/promises');
  const coordinator = await readFile(new URL('../src/host/upgradeAssistantCoordinator.ts', import.meta.url), 'utf8');
  assert.match(coordinator, /platform\.log\?\.\(diagnosticLine\(\{\s*area: 'version-list'/);
  const controller = await readFile(new URL('../src/host/dashboardController.ts', import.meta.url), 'utf8');
  assert.match(controller, /onDiagnostic: \(entry\) => this\.options\.log\?\.\(diagnosticLine\(entry\)\)/);
});
