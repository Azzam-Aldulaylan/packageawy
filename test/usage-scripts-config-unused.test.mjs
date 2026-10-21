/**
 * package.json script detection, recognized-config-file text matching,
 * framework-convention heuristics, @types name mapping, and the "likely
 * unused" finding builder:
 * src/core/usage/{packageScripts,configHeuristics,frameworkConventions,packageNameMatch,unused}.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findPackageInScripts } from '../out/core/usage/packageScripts.js';
import { CONFIG_FILE_GLOBS, configReferencesPackage } from '../out/core/usage/configHeuristics.js';
import { isFrameworkConventionPackage } from '../out/core/usage/frameworkConventions.js';
import { typesPackageTarget } from '../out/core/usage/packageNameMatch.js';
import { buildUnusedFinding } from '../out/core/usage/unused.js';

// --------------------------------------------------------------- scripts

test('a package invoked directly in a package.json script is found', () => {
  const manifest = JSON.stringify({ scripts: { lint: 'eslint .' } });
  const matches = findPackageInScripts(manifest, 'eslint');
  assert.deepEqual(matches, [{ scriptName: 'lint', scriptCommand: 'eslint .' }]);
});

test('a scoped package is matched by its own sub-name too', () => {
  const manifest = JSON.stringify({ scripts: { lint: 'parser --check' } });
  const matches = findPackageInScripts(manifest, '@typescript-eslint/parser');
  assert.equal(matches.length, 1);
});

test('a package name that is only a substring of another token does not match', () => {
  const manifest = JSON.stringify({ scripts: { build: 'esbuild-wrapper --minify' } });
  assert.deepEqual(findPackageInScripts(manifest, 'esbuild'), []);
});

test('a package not mentioned in any script produces no matches', () => {
  const manifest = JSON.stringify({ scripts: { test: 'node --test' } });
  assert.deepEqual(findPackageInScripts(manifest, 'jest'), []);
});

test('invalid manifest JSON degrades to no scripts rather than throwing', () => {
  assert.deepEqual(findPackageInScripts('not json', 'eslint'), []);
});

// --------------------------------------------------------------- config

test('usage config discovery includes extensionless ESLint and Babel inputs', () => {
  assert.equal(CONFIG_FILE_GLOBS.includes('.eslintrc'), true);
  assert.equal(CONFIG_FILE_GLOBS.includes('.babelrc'), true);
});

test('usage config discovery includes React Native host configuration', () => {
  assert.equal(CONFIG_FILE_GLOBS.includes('metro.config.*'), true);
  assert.equal(CONFIG_FILE_GLOBS.includes('react-native.config.*'), true);
});

test('a package referenced in a config file body is found', () => {
  assert.equal(configReferencesPackage(`module.exports = { plugins: ['tailwindcss'] };`, 'tailwindcss'), true);
});

test('a package not referenced in a config file body is not found', () => {
  assert.equal(configReferencesPackage(`module.exports = { plugins: ['postcss-import'] };`, 'tailwindcss'), false);
});

test('a scoped package is matched by its full name in config content', () => {
  assert.equal(
    configReferencesPackage(`{ "plugins": ["@typescript-eslint/eslint-plugin"] }`, '@typescript-eslint/eslint-plugin'),
    true
  );
});

test('a scoped package is matched by its own sub-name in config content', () => {
  assert.equal(configReferencesPackage(`{ "parser": "@typescript-eslint/parser" }`, '@typescript-eslint/parser'), true);
});

test('ESLint extends shorthand resolves to the eslint-config package', () => {
  const eslintrc = JSON.stringify({ extends: ['next/core-web-vitals'] });
  assert.equal(configReferencesPackage(eslintrc, 'eslint-config-next', '.eslintrc.json'), true);
  assert.equal(configReferencesPackage(`{ "extends": "next" }`, 'eslint-config-next', '.eslintrc.json'), true);
  assert.equal(configReferencesPackage(`{ "extends": ["prettier"] }`, 'eslint-config-prettier', '.eslintrc'), true);
});

test('ESLint plugin shorthand resolves to the eslint-plugin package', () => {
  const eslintrc = `module.exports = { extends: ['plugin:react/recommended'] };`;
  assert.equal(configReferencesPackage(eslintrc, 'eslint-plugin-react', '.eslintrc.js'), true);
  assert.equal(configReferencesPackage(`{ "plugins": ["tailwindcss"] }`, 'eslint-plugin-tailwindcss', '.eslintrc.json'), true);
});

test('scoped ESLint shorthand resolves to the scoped config or plugin package', () => {
  assert.equal(configReferencesPackage(`{ "extends": ["@acme"] }`, '@acme/eslint-config', '.eslintrc.json'), true);
  assert.equal(configReferencesPackage(`{ "extends": ["@acme/base"] }`, '@acme/eslint-config-base', '.eslintrc.json'), true);
  assert.equal(
    configReferencesPackage(`{ "extends": ["plugin:@typescript-eslint/recommended"] }`, '@typescript-eslint/eslint-plugin', '.eslintrc.json'),
    true
  );
  assert.equal(
    configReferencesPackage(`{ "extends": ["plugin:@next/next/recommended"] }`, '@next/eslint-plugin-next', '.eslintrc.json'),
    true
  );
  assert.equal(configReferencesPackage(`{ "extends": ["@acme/base"] }`, '@acme/eslint-config', '.eslintrc.json'), false);
});

test('ESLint shorthand inside a flat config FlatCompat call is recognized', () => {
  const flat = `export default [...compat.extends("next/core-web-vitals")];`;
  assert.equal(configReferencesPackage(flat, 'eslint-config-next', 'eslint.config.mjs'), true);
});

test('ESLint shorthand only counts in ESLint config files and only as a quoted value', () => {
  const nextConfig = `module.exports = { experimental: { appDir: "next" } };`;
  assert.equal(configReferencesPackage(nextConfig, 'eslint-config-next', 'next.config.js'), false);
  assert.equal(configReferencesPackage(nextConfig, 'eslint-config-next'), false);
  assert.equal(configReferencesPackage(`{ "settings": { "next": { "rootDir": "." } } }`, 'eslint-config-next', '.eslintrc.json'), false);
  assert.equal(configReferencesPackage(`{ "extends": ["nextra"] }`, 'eslint-config-next', '.eslintrc.json'), false);
});

// ---------------------------------------------------- framework conventions

test('known ESLint/Babel/PostCSS plugin naming conventions are recognized', () => {
  assert.equal(isFrameworkConventionPackage('eslint-plugin-react'), true);
  assert.equal(isFrameworkConventionPackage('babel-preset-env'), true);
  assert.equal(isFrameworkConventionPackage('@babel/core'), true);
  assert.equal(isFrameworkConventionPackage('postcss-import'), true);
});

test('well-known CLI tooling packages are recognized', () => {
  assert.equal(isFrameworkConventionPackage('typescript'), true);
  assert.equal(isFrameworkConventionPackage('eslint'), true);
});

test('React Native convention-loaded packages are handled conservatively', () => {
  assert.equal(isFrameworkConventionPackage('react-native-svg-transformer'), true);
  assert.equal(isFrameworkConventionPackage('@react-native/metro-config'), true);
  assert.equal(isFrameworkConventionPackage('@react-native-community/netinfo'), true);
});

test('@types packages are handled conservatively', () => {
  assert.equal(isFrameworkConventionPackage('@types/node'), true);
  assert.equal(isFrameworkConventionPackage('@types/react'), true);
});

test('@types package names map to the package they describe', () => {
  assert.equal(typesPackageTarget('@types/react'), 'react');
  assert.equal(typesPackageTarget('@types/babel__core'), '@babel/core');
  assert.equal(typesPackageTarget('react'), null);
  assert.equal(typesPackageTarget('@types/'), null);
  assert.equal(typesPackageTarget('@types/__core'), null);
});

test('an ordinary application dependency is not a framework-convention package', () => {
  assert.equal(isFrameworkConventionPackage('react'), false);
  assert.equal(isFrameworkConventionPackage('axios'), false);
});

// ------------------------------------------------------------------ unused

function usage(overrides) {
  return {
    packageName: 'left-pad',
    references: [],
    truncated: false,
    scannedFileCount: 10,
    scannedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a package with zero references and no convention match is a high-confidence finding', () => {
  const finding = buildUnusedFinding('left-pad', usage({}));
  assert.equal(finding.kind, 'likely-unused');
  assert.equal(finding.confidence, 'high');
  assert.equal(finding.severity, 'warning');
});

test('a package with at least one reference produces no finding', () => {
  const found = usage({ references: [{ filePath: 'src/x.ts', line: 1, column: 1, snippet: '', kind: 'import' }] });
  assert.equal(buildUnusedFinding('left-pad', found), null);
});

test('a framework-convention package with zero references is a low-confidence "possibly unused" finding', () => {
  const finding = buildUnusedFinding('eslint-plugin-react', usage({ packageName: 'eslint-plugin-react' }));
  assert.equal(finding.confidence, 'low');
  assert.equal(finding.severity, 'info');
  assert.match(finding.summary, /may be unused/);
});

test('a truncated scan with zero references is downgraded to low confidence regardless of the package name', () => {
  const finding = buildUnusedFinding('left-pad', usage({ truncated: true }));
  assert.equal(finding.confidence, 'low');
  assert.equal(finding.evidence.truncated, true);
});

test('a production and a dev dependency are graded identically: classification does not affect confidence', () => {
  const prod = buildUnusedFinding('left-pad', usage({}));
  const dev = buildUnusedFinding('left-pad', usage({}));
  assert.equal(prod.confidence, dev.confidence);
});

test('a direct dependency required as a peer by another installed package produces no finding', () => {
  const finding = buildUnusedFinding('@tiptap/pm', usage({ packageName: '@tiptap/pm' }), {
    peerRequirements: [{ requiredBy: '@tiptap/starter-kit', range: '^2.0.0', optional: false }],
  });
  assert.equal(finding, null);
});

test('an optional peer requirement keeps the finding but only at low confidence', () => {
  const finding = buildUnusedFinding('left-pad', usage({}), {
    peerRequirements: [{ requiredBy: 'pad-utils', range: '*', optional: true }],
  });
  assert.equal(finding.confidence, 'low');
  assert.match(finding.evidence.reason, /optional peer dependency of pad-utils/);
});

test('@types/<name> produces no finding when <name> is a direct dependency', () => {
  const directDependencies = new Set(['react', '@babel/core', '@types/react', '@types/babel__core']);
  assert.equal(buildUnusedFinding('@types/react', usage({ packageName: '@types/react' }), { directDependencies }), null);
  assert.equal(buildUnusedFinding('@types/babel__core', usage({ packageName: '@types/babel__core' }), { directDependencies }), null);
});

test('@types/<name> without its package or an import is never a high-confidence finding', () => {
  const finding = buildUnusedFinding('@types/node', usage({ packageName: '@types/node' }), {
    directDependencies: new Set(['@types/node']),
  });
  assert.equal(finding.confidence, 'low');
  assert.equal(finding.severity, 'info');
  assert.match(finding.evidence.reason, /No imports of node found/);
});
