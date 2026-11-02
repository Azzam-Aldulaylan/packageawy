import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_VERIFICATION_SUGGESTIONS,
  isSafeScriptName,
  suggestVerificationScripts,
} from '../out/core/upgrade/verificationSuggestions.js';

const suggest = (scripts) => suggestVerificationScripts(scripts);
const accepts = (script, name = 'test') => suggest({ [name]: script }).includes(name);

test('suggests typecheck, build, test and lint in that order', () => {
  assert.deepEqual(
    suggest({ lint: 'eslint .', test: 'node --test', build: 'tsc -p .', typecheck: 'tsc --noEmit', dev: 'vite' }),
    ['typecheck', 'build', 'test', 'lint']
  );
  assert.equal(MAX_VERIFICATION_SUGGESTIONS, 4);
});

test('type-check is used when typecheck is absent, and typecheck wins when both exist', () => {
  assert.deepEqual(suggest({ 'type-check': 'vue-tsc --noEmit', test: 'jest' }), ['type-check', 'test']);
  assert.deepEqual(suggest({ typecheck: 'tsc --noEmit', 'type-check': 'tsc --noEmit' }), ['typecheck']);
});

test('only the four known names are ever suggested', () => {
  assert.deepEqual(suggest({ 'test:unit': 'vitest run', check: 'tsc', ci: 'npm test', format: 'prettier --check .' }), []);
});

test('non-object scripts and non-string values yield nothing', () => {
  assert.deepEqual(suggest(undefined), []);
  assert.deepEqual(suggest(null), []);
  assert.deepEqual(suggest(['build']), []);
  assert.deepEqual(suggest('tsc'), []);
  assert.deepEqual(suggest({ build: 12, test: null, lint: { cmd: 'eslint' } }), []);
  assert.deepEqual(suggest({ build: '', test: '   ' }), []);
});

test('inherited properties are never treated as scripts', () => {
  const scripts = Object.create({ build: 'tsc' });
  assert.deepEqual(suggest(scripts), []);
});

test("npm's placeholder test script and close variants are excluded", () => {
  assert.equal(accepts('echo "Error: no test specified" && exit 1'), false);
  assert.equal(accepts("echo 'Error: no test specified' && exit 1"), false);
  assert.equal(accepts('echo \\"Error: no test specified\\" && exit 1'), false);
  assert.equal(accepts('echo "No tests yet"'), false);
  assert.equal(accepts('echo "no tests configured" ; exit 0'), false);
  assert.equal(accepts('exit 1'), false);
  assert.equal(accepts('echo ok'), false, 'a script that only prints checks nothing');
  assert.equal(accepts('true'), false);
});

test('watch flags are excluded, explicit watch=false is not', () => {
  assert.equal(accepts('jest --watch'), false);
  assert.equal(accepts('jest --watchAll'), false);
  assert.equal(accepts('tsc --watch', 'build'), false);
  assert.equal(accepts('tsc -w', 'build'), false);
  assert.equal(accepts('node --watch --test'), false);
  assert.equal(accepts('mocha --watch=true'), false);
  assert.equal(accepts('jest --watchman'), true, '--watchman is not watch mode');
  assert.equal(accepts('react-scripts test --watchAll=false'), true);
  assert.equal(accepts('ng test --watch=false'), true);
});

test('vitest is accepted only with a run subcommand or --run', () => {
  assert.equal(accepts('vitest'), false);
  assert.equal(accepts('vitest --coverage'), false);
  assert.equal(accepts('vitest watch'), false);
  assert.equal(accepts('vitest dev'), false);
  assert.equal(accepts('vitest run'), true);
  assert.equal(accepts('vitest --run'), true);
  assert.equal(accepts('npx vitest run --coverage'), true);
  assert.equal(accepts('./node_modules/.bin/vitest'), false);
});

test('test runners that watch by default are excluded', () => {
  assert.equal(accepts('react-scripts test'), false);
  assert.equal(accepts('craco test'), false);
  assert.equal(accepts('ng test'), false);
  assert.equal(accepts('karma start --single-run'), false, 'karma is too varied to trust');
  assert.equal(accepts('jest'), true);
  assert.equal(accepts('jest --ci --coverage'), true);
});

test('dev servers and long-running processes are excluded', () => {
  for (const script of [
    'vite',
    'vite dev',
    'vite serve',
    'vite preview',
    'next dev',
    'next start',
    'ng serve',
    'nodemon src/index.js',
    'webpack serve',
    'webpack-dev-server',
    'parcel index.html',
    'nuxt dev',
    'astro dev',
    'gatsby develop',
    'react-scripts start',
    'http-server dist',
    'serve -s build',
    'tsx watch src/index.ts',
    'concurrently "tsc -w" "vite"',
    'npm start',
  ]) {
    assert.equal(accepts(script, 'build'), false, script);
  }
});

test('one-shot builds are accepted', () => {
  for (const script of [
    'tsc -p tsconfig.json',
    'vite build',
    'next build',
    'ng build',
    'parcel build index.html',
    'webpack --mode production',
    'rimraf dist && tsc',
    'NODE_ENV=production rollup -c',
  ]) {
    assert.equal(accepts(script, 'build'), true, script);
  }
});

test('a background job is excluded but && and redirections are not', () => {
  assert.equal(accepts('node server.js & jest'), false);
  assert.equal(accepts('tsc && jest'), true);
  assert.equal(accepts('jest 2>&1'), true);
  assert.equal(accepts('jest &> out.log'), true);
});

test('scripts that run other scripts are judged by what they run', () => {
  assert.deepEqual(suggest({ test: 'npm run lint && npm run test:unit', lint: 'eslint .', 'test:unit': 'vitest run' }), ['test', 'lint']);
  assert.deepEqual(suggest({ test: 'npm run test:unit', 'test:unit': 'vitest' }), []);
  assert.deepEqual(suggest({ build: 'pnpm compile', compile: 'tsc' }), ['build']);
  assert.deepEqual(suggest({ build: 'yarn run compile', compile: 'vite' }), []);
  assert.deepEqual(suggest({ build: 'npm run compile' }), [], 'a missing referenced script would fail');
  assert.deepEqual(suggest({ build: 'npm run build' }), [], 'a self reference never ends');
  assert.deepEqual(suggest({ build: 'npm run a', a: 'npm run b', b: 'npm run a' }), [], 'a cycle never ends');
  assert.deepEqual(suggest({ test: 'npm run dev', dev: 'node --test' }), [], 'dev is treated as a server by name');
  assert.deepEqual(suggest({ lint: 'npm test', test: 'jest --watch' }), []);
});

test('deeply nested script chains are not followed', () => {
  assert.deepEqual(
    suggest({ build: 'npm run a', a: 'npm run b', b: 'npm run c', c: 'npm run d', d: 'tsc' }),
    []
  );
  assert.deepEqual(suggest({ build: 'npm run a', a: 'npm run b', b: 'tsc' }), ['build']);
});

test('scripts that run other workspace packages are not suggested', () => {
  assert.deepEqual(suggest({ build: 'pnpm -r run build' }), []);
  assert.deepEqual(suggest({ build: 'pnpm --filter web build' }), []);
  assert.deepEqual(suggest({ test: 'npm test --workspaces' }), []);
  assert.deepEqual(suggest({ build: 'turbo run build' }), ['build']);
});

test('names outside the safe script-name rule are never suggested', () => {
  assert.equal(isSafeScriptName('build'), true);
  assert.equal(isSafeScriptName('test:unit'), true);
  assert.equal(isSafeScriptName('-x'), false);
  assert.equal(isSafeScriptName('a b'), false);
  assert.equal(isSafeScriptName(''), false);
});

test('pre and post scripts that npm runs alongside are judged too', () => {
  assert.deepEqual(suggest({ test: 'node --test', pretest: 'tsc -p .', posttest: 'eslint .' }), ['test']);
  assert.deepEqual(suggest({ test: 'node --test', posttest: 'http-server dist' }), []);
  assert.deepEqual(suggest({ build: 'tsc', prebuild: 'tsc --watch' }), []);
});

test('commands behind environment wrappers are judged by what they run', () => {
  assert.deepEqual(suggest({ test: 'cross-env NODE_ENV=test ng test' }), []);
  assert.deepEqual(suggest({ test: 'cross-env CI=true NODE_ENV=test jest --watch' }), []);
  assert.deepEqual(suggest({ test: 'env -i NODE_ENV=test vitest' }), []);
  assert.deepEqual(suggest({ test: 'dotenv -e .env.test -- vitest' }), []);
  assert.deepEqual(suggest({ test: 'pnpm dlx vitest' }), []);
  assert.deepEqual(suggest({ test: 'cross-env NODE_ENV=test jest' }), ['test']);
  assert.deepEqual(suggest({ test: 'dotenv -e .env.test -- vitest run' }), ['test']);
  assert.deepEqual(suggest({ test: 'cross-env NODE_ENV=test npx --yes vitest run' }), ['test']);
});

test('wrappers whose command cannot be found are not suggested', () => {
  assert.deepEqual(suggest({ test: 'dotenv -e .env.test vitest run' }), []);
  assert.deepEqual(suggest({ test: 'cross-env NODE_ENV=test' }), []);
  assert.deepEqual(suggest({ build: 'cross-env-shell "tsc && echo done"' }), []);
  assert.deepEqual(suggest({ test: 'env -u CI jest' }), []);
});

test('a hook only has to finish, it does not have to check anything', () => {
  assert.deepEqual(suggest({ build: 'tsc', postbuild: 'echo Build complete' }), ['build']);
  assert.deepEqual(suggest({ test: 'node --test', pretest: 'echo starting' }), ['test']);
  assert.deepEqual(suggest({ build: 'tsc', postbuild: 'exit 1' }), []);
  assert.deepEqual(suggest({ build: 'echo only' }), []);
});
