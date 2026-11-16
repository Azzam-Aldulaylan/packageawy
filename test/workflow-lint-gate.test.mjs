/**
 * Lint runs before every build, test and publish job, from every way a
 * workflow can start. Both hosts are covered: the JetBrains sidecar is built
 * from the same source.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import yaml from 'js-yaml';

const LINT_WORKFLOW = './.github/workflows/lint.yml';

function workflow(name) {
  return yaml.load(readFileSync(`.github/workflows/${name}`, 'utf8'));
}

/** Trigger names. js-yaml reads the bare `on` key as the string "on". */
function triggers(file) {
  const on = file.on ?? file.true;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

function needsOf(job) {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/** True when `jobName` is the lint job or depends on it, directly or through other jobs. */
function reachesLint(jobs, jobName, seen = new Set()) {
  if (seen.has(jobName)) return false;
  seen.add(jobName);
  const job = jobs[jobName];
  assert.ok(job, `job ${jobName} exists`);
  if (job.uses === LINT_WORKFLOW) return true;
  return needsOf(job).some((dependency) => reachesLint(jobs, dependency, seen));
}

test('the lint workflow is reusable only and runs lint and the strict typecheck', () => {
  const lint = workflow('lint.yml');
  assert.deepEqual(triggers(lint), ['workflow_call']);
  const runs = Object.values(lint.jobs).flatMap((job) => job.steps.map((step) => step.run).filter(Boolean));
  assert.ok(runs.includes('npm ci'));
  assert.ok(runs.includes('npm run lint'));
  assert.ok(runs.includes('npm run typecheck'));
});

test('JetBrains builds only when CI calls it, so it has no entry point that skips lint', () => {
  assert.deepEqual(triggers(workflow('jetbrains.yml')), ['workflow_call']);
  const ci = workflow('ci.yml');
  const callers = Object.entries(ci.jobs).filter(([, job]) => job.uses === './.github/workflows/jetbrains.yml');
  assert.equal(callers.length, 1);
  assert.ok(reachesLint(ci.jobs, callers[0][0]));
});

test('CI starts on push, pull request and by hand, and every job waits for lint', () => {
  const ci = workflow('ci.yml');
  assert.deepEqual(triggers(ci).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  const lintJobs = Object.entries(ci.jobs).filter(([, job]) => job.uses === LINT_WORKFLOW);
  assert.equal(lintJobs.length, 1, 'lint runs once per CI run');
  for (const name of Object.keys(ci.jobs)) assert.ok(reachesLint(ci.jobs, name), `${name} waits for lint`);
  assert.deepEqual(needsOf(ci.jobs['vsix-smoke']), ['package-vsix'], 'the smoke tests still use the packaged VSIX');
});

test('every release job, including both publish paths, waits for lint', () => {
  const release = workflow('release.yml');
  assert.deepEqual(triggers(release), ['workflow_dispatch']);
  for (const name of Object.keys(release.jobs)) assert.ok(reachesLint(release.jobs, name), `${name} waits for lint`);
});

test('no workflow that can start on its own has a job outside the lint gate', () => {
  for (const name of readdirSync('.github/workflows').filter((file) => /\.ya?ml$/.test(file))) {
    const file = workflow(name);
    if (triggers(file).every((trigger) => trigger === 'workflow_call')) continue;
    for (const job of Object.keys(file.jobs)) assert.ok(reachesLint(file.jobs, job), `${name}: ${job} waits for lint`);
  }
});

test('the local release check lints first, and the unused checks are on', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(manifest.scripts.lint, 'eslint src webview/src --max-warnings 0');
  assert.match(manifest.scripts['test:release'], /^npm run lint && /);
  for (const config of ['tsconfig.json', 'webview/tsconfig.json']) {
    const options = JSON.parse(readFileSync(config, 'utf8')).compilerOptions;
    assert.equal(options.noUnusedLocals, true, config);
    assert.equal(options.noUnusedParameters, true, config);
  }
});

test('the lint config enforces the promise rules with void not allowed as an escape', () => {
  const config = readFileSync('eslint.config.mjs', 'utf8');
  assert.match(config, /'@typescript-eslint\/no-floating-promises': \['error', \{\s*ignoreVoid: false,\s*ignoreIIFE: false,\s*checkThenables: true,/);
  assert.match(config, /'@typescript-eslint\/no-misused-promises': 'error'/);
  assert.match(config, /projectService: true/);
  // No blanket opt-outs in the linted source.
  for (const dir of ['src', 'webview/src']) {
    for (const file of readdirSync(dir, { recursive: true }).filter((entry) => /\.tsx?$/.test(entry))) {
      assert.doesNotMatch(readFileSync(`${dir}/${file}`, 'utf8'), /eslint-disable/, `${dir}/${file}`);
    }
  }
});
