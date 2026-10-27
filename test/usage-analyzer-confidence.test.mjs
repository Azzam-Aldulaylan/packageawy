import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';

const brokenSourceFiles = ['/workspace/src/oversized.ts', '/workspace/src/unreadable.ts'];

// Each test sets the files the fake workspace search returns. A file with
// no `text` reports as oversized or fails to read.
let workspace = { sourceFiles: [], configFiles: [], text: new Map() };

const platform = {
  findFiles: async (search) => search.include.includes('*.{js,jsx,ts,tsx,mjs,cjs}') ? workspace.sourceFiles : workspace.configFiles,
  statFile: async (filePath) => ({ size: filePath.endsWith('oversized.ts') ? 3 * 1024 * 1024 : 10 }),
  readFile: async (filePath) => {
    const text = workspace.text.get(filePath);
    if (text === undefined) throw new Error('permission denied');
    return new TextEncoder().encode(text);
  },
};

const folder = { id: 'file:///workspace', name: 'workspace', path: '/workspace' };

test('oversized and unreadable eligible files make a zero-reference usage result incomplete', async () => {
  workspace = { sourceFiles: brokenSourceFiles, configFiles: [], text: new Map() };
  const results = await analyzeDependencyUsage({
    platform,
    folder,
    dir: '',
    manifestText: '{}',
    packageNames: ['left-pad'],
    maxFiles: 10,
    token: { isCancellationRequested: false },
  });

  const result = results.get('left-pad');
  assert.notEqual(result, undefined);
  assert.deepEqual(result.references, []);
  assert.equal(result.truncated, true, 'missing evidence must never become a complete unused/low-risk result');
});

test('an ESLint extends shorthand counts as a config reference for the resolved package', async () => {
  workspace = {
    sourceFiles: [],
    configFiles: ['/workspace/.eslintrc.json'],
    text: new Map([['/workspace/.eslintrc.json', JSON.stringify({ extends: 'next/core-web-vitals' })]]),
  };
  const results = await analyzeDependencyUsage({
    platform,
    folder,
    dir: '',
    manifestText: '{}',
    packageNames: ['eslint-config-next', 'eslint-plugin-react'],
    maxFiles: 10,
    token: { isCancellationRequested: false },
  });

  assert.deepEqual(results.get('eslint-config-next').references.map((reference) => [reference.kind, reference.context]), [
    ['config', '.eslintrc.json'],
  ]);
  assert.deepEqual(results.get('eslint-plugin-react').references, []);
  assert.equal(results.get('eslint-config-next').truncated, false);
});

test('a source import of a package is usage evidence for its @types package', async () => {
  workspace = {
    sourceFiles: ['/workspace/src/page.tsx'],
    configFiles: [],
    text: new Map([['/workspace/src/page.tsx', `import { marked } from 'marked';\n`]]),
  };
  const results = await analyzeDependencyUsage({
    platform,
    folder,
    dir: '',
    manifestText: '{}',
    packageNames: ['@types/marked'],
    maxFiles: 10,
    token: { isCancellationRequested: false },
  });

  assert.deepEqual(results.get('@types/marked').references.map((reference) => reference.filePath), ['src/page.tsx']);
});
