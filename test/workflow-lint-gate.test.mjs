/**
 * Lint runs before every build, test and publish job, from every way a
 * workflow can start. Both hosts are covered: the JetBrains sidecar is built
 * from the same source.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('every release job waits for lint', () => {
  const release = workflow('release.yml');
  assert.deepEqual(triggers(release), ['workflow_dispatch']);
  for (const name of Object.keys(release.jobs)) assert.ok(reachesLint(release.jobs, name), `${name} waits for lint`);
});

const storeJobs = {
  'publish-jetbrains': 'publish_jetbrains',
  'publish-marketplace': 'publish_marketplace',
  'publish-open-vsx': 'publish_open_vsx',
};

// These job conditions use booleans and comparisons shared by Actions and JavaScript.
function jobCondition(condition, inputs, needs, cancelled = false) {
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll(/needs\.([\w-]+)\.result/g, (_, name) => `needs[${JSON.stringify(name)}].result`);
  return new Function('inputs', 'needs', 'cancelled', `return Boolean(${expression});`)(inputs, needs, () => cancelled);
}

test('release publishing waits for verification, smoke tests, JetBrains and shared secrets preflight', () => {
  const release = workflow('release.yml');
  assert.equal(release.on.workflow_dispatch.inputs.pre_release.default, false);
  const { jetbrains, smoke, 'secrets-preflight': preflight } = release.jobs;
  assert.equal(jetbrains.if, undefined);
  assert.deepEqual(needsOf(jetbrains), ['verify']);
  assert.deepEqual(needsOf(smoke), ['verify', 'package']);
  assert.deepEqual(needsOf(preflight), ['verify', 'smoke', 'jetbrains']);
  assert.equal(preflight.if, '${{ !inputs.dry_run }}');
  for (const [name, input] of Object.entries(storeJobs)) {
    const job = release.jobs[name];
    assert.deepEqual(needsOf(job), ['verify', 'smoke', 'jetbrains', 'secrets-preflight']);
    assert.equal(job.if, '${{ !inputs.dry_run && inputs.' + input + ' }}');
    assert.equal(job.environment, 'release');
    assert.equal(job.permissions?.contents, undefined, 'only the final release job writes repository contents');
    for (const [otherName, otherInput] of Object.entries(storeJobs)) {
      const inputs = { dry_run: false, [otherInput]: true };
      assert.equal(jobCondition(job.if, inputs, {}), name === otherName, `${name} can be rerun independently`);
      assert.equal(jobCondition(job.if, { ...inputs, dry_run: true }, {}), false, 'dry runs never publish');
    }
    const confirm = job.steps.findIndex((step) => /^Confirm the /.test(step.name ?? ''));
    const publish = job.steps.findIndex((step) => /gradlew publishPlugin|npx vsce|npx --yes ovsx/.test(step.run ?? ''));
    assert.ok(confirm >= 0 && publish > confirm, `${name} confirms its artifact before publishing`);
  }
  const commands = jetbrains.steps.map((step) => step.run ?? '').join('\n');
  assert.match(commands, /gradlew build buildPlugin -Ppackageawy.stubSidecar=false/);
  assert.match(commands, /gradlew verifyPlugin -Ppackageawy.stubSidecar=false/);
  assert.match(commands, /if \[ ! -f dist\/sidecar.js \]/);
  assert.doesNotMatch(commands, /signPlugin|publishPlugin/);
  assert.ok(jetbrains.steps.some((step) => step.uses === 'actions/upload-artifact@v4' && step.with.name === 'jetbrains'));
  const plugin = release.jobs['publish-jetbrains'];
  assert.ok(plugin.steps.some((step) => step.uses === 'actions/download-artifact@v4' && step.with.name === 'jetbrains' && step.with.path === 'jetbrains/verified'));
  const signing = plugin.steps.findIndex((step) => /gradlew signPlugin/.test(step.run ?? ''));
  const artifact = plugin.steps.findIndex((step) => step.uses === 'actions/upload-artifact@v4' && step.with.name === 'jetbrains-signed');
  const lookup = plugin.steps.findIndex((step) => /node scripts\/release\/check-jetbrains-version.mjs/.test(step.run ?? ''));
  const publishing = plugin.steps.findIndex((step) => /gradlew publishPlugin/.test(step.run ?? ''));
  assert.ok(signing >= 0 && artifact > signing && lookup > artifact && publishing > lookup);
  const pluginSign = plugin.steps[signing];
  assert.match(pluginSign.run, /zips=\(verified\/\*\.zip\)/);
  assert.match(pluginSign.run, /-x buildPlugin -Ppackageawy.publishArchive="\$\{zips\[0\]\}" .*--no-configuration-cache/);
  assert.match(pluginSign.run, /echo "archive=\$\{zips\[0\]\}" >> "\$GITHUB_OUTPUT"/);
  assert.equal(pluginSign.env.JETBRAINS_PUBLISH_TOKEN, undefined);
  assert.equal(plugin.steps[artifact].with.overwrite, true, 'a failed job can replace its signed artifact on retry');
  const pluginCheck = plugin.steps[lookup];
  assert.equal(pluginCheck.env.VERSION, '${{ needs.verify.outputs.version }}');
  assert.equal(pluginCheck['continue-on-error'], undefined, 'API errors stop publication');
  const pluginPublish = plugin.steps[publishing];
  assert.equal(pluginPublish.if, '${{ steps.' + pluginCheck.id + '.outputs.exists == \'false\' }}');
  assert.equal(pluginPublish.env.VERIFIED_ARCHIVE, '${{ steps.' + pluginSign.id + '.outputs.archive }}');
  assert.match(pluginPublish.run, /-x buildPlugin -x signPlugin -Ppackageawy.publishArchive="\$VERIFIED_ARCHIVE" .*--no-configuration-cache/);
  for (const name of ['publish-marketplace', 'publish-open-vsx']) {
    assert.match(release.jobs[name].steps.map((step) => step.run ?? '').join('\n'), /--skip-duplicate/);
  }
});

test('the final release runs only after all selected store jobs succeed', () => {
  const { jobs } = workflow('release.yml');
  const final = jobs.release;
  const dependencies = ['verify', 'smoke', 'jetbrains', 'secrets-preflight', ...Object.keys(storeJobs)];
  assert.deepEqual(needsOf(final), dependencies);
  assert.equal(final.environment, 'release');
  assert.equal(final.permissions.contents, 'write');
  for (let selection = 0; selection < 8; selection++) {
    const inputs = { dry_run: false };
    const needs = Object.fromEntries(dependencies.map((name) => [name, { result: 'success' }]));
    Object.entries(storeJobs).forEach(([name, input], index) => {
      inputs[input] = Boolean(selection & (1 << index));
      needs[name] = { result: inputs[input] ? 'success' : 'skipped' };
    });
    assert.equal(jobCondition(final.if, inputs, needs), true, `store selection ${selection}`);
    assert.equal(jobCondition(final.if, { ...inputs, dry_run: true }, needs), false);
    assert.equal(jobCondition(final.if, inputs, needs, true), false);
    for (const name of dependencies) {
      for (const result of ['failure', 'cancelled']) {
        assert.equal(jobCondition(final.if, inputs, { ...needs, [name]: { result } }), false, `${name} ${result}`);
      }
      if (!(name in storeJobs)) {
        assert.equal(jobCondition(final.if, inputs, { ...needs, [name]: { result: 'skipped' } }), false, `${name} skipped`);
      }
    }
  }
  assert.ok(final.steps.some((step) => step.uses === 'actions/download-artifact@v4' && step.with.name === 'jetbrains-signed'));
  for (const [name, job] of Object.entries(jobs)) {
    const text = JSON.stringify(job);
    if (/secrets\.|github.token|gh release|gradlew publishPlugin|npx vsce|npx --yes ovsx/.test(text)) {
      assert.equal(job.environment, 'release', `${name} uses the release environment`);
    }
    if (name !== 'release') assert.doesNotMatch(text, /gh release (create|upload)|git (tag|push)/);
  }
});

test('all selected store secrets pass before any release publication', () => {
  const check = workflow('release.yml').jobs['secrets-preflight'].steps[0];
  assert.equal(check.name, 'Check publish secrets');
  const env = Object.fromEntries(Object.keys(check.env).map((key) => [key, 'true']));
  const run = (values) => spawnSync('bash', ['-e', '-c', check.run], { env: values, encoding: 'utf8' });
  assert.equal(run(env).status, 0);
  const secretGroups = {
    PUBLISH_MARKETPLACE: ['HAS_VSCE_PAT'],
    PUBLISH_OPEN_VSX: ['HAS_OVSX_PAT'],
    PUBLISH_JETBRAINS: ['HAS_TOKEN', 'HAS_CHAIN', 'HAS_KEY', 'HAS_PASSWORD'],
  };
  for (const [selection, secrets] of Object.entries(secretGroups)) {
    for (const key of secrets) {
      const result = run({ ...env, [key]: 'false' });
      assert.equal(result.status, 1, key);
      assert.match(result.stdout, /::error::/);
    }
    const missing = Object.fromEntries(secrets.map((key) => [key, 'false']));
    assert.equal(run({ ...env, ...missing, [selection]: 'false' }).status, 0, `${selection} unselected`);
  }
  const allMissing = Object.fromEntries(Object.values(secretGroups).flat().map((key) => [key, 'false']));
  const result = run({ ...env, ...allMissing });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.match(/::error::/g).length, 6, 'reports every missing secret together');
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
