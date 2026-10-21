import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const brokenSourceUris = [
  { fsPath: '/workspace/src/oversized.ts' },
  { fsPath: '/workspace/src/unreadable.ts' },
];

// Each test sets the files the mocked workspace search returns. A file with
// no `text` reports as oversized or fails to read.
let workspace = { sourceUris: [], configUris: [], text: new Map() };

const vscode = {
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  workspace: {
    findFiles: async (pattern) => pattern.pattern.includes('*.{js,jsx,ts,tsx,mjs,cjs}') ? workspace.sourceUris : workspace.configUris,
    fs: {
      stat: async (uri) => ({ size: uri.fsPath.endsWith('oversized.ts') ? 3 * 1024 * 1024 : 10 }),
      readFile: async (uri) => {
        const text = workspace.text.get(uri.fsPath);
        if (text === undefined) throw new Error('permission denied');
        return new TextEncoder().encode(text);
      },
    },
  },
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
};

const originalLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
const { analyzeDependencyUsage } = require('../out/host/usage/usageAnalyzer.js');
Module._load = originalLoad;

const folder = { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 };

test('oversized and unreadable eligible files make a zero-reference usage result incomplete', async () => {
  workspace = { sourceUris: brokenSourceUris, configUris: [], text: new Map() };
  const results = await analyzeDependencyUsage({
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
    sourceUris: [],
    configUris: [{ fsPath: '/workspace/.eslintrc.json' }],
    text: new Map([['/workspace/.eslintrc.json', JSON.stringify({ extends: 'next/core-web-vitals' })]]),
  };
  const results = await analyzeDependencyUsage({
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
    sourceUris: [{ fsPath: '/workspace/src/page.tsx' }],
    configUris: [],
    text: new Map([['/workspace/src/page.tsx', `import { marked } from 'marked';\n`]]),
  };
  const results = await analyzeDependencyUsage({
    folder,
    dir: '',
    manifestText: '{}',
    packageNames: ['@types/marked'],
    maxFiles: 10,
    token: { isCancellationRequested: false },
  });

  assert.deepEqual(results.get('@types/marked').references.map((reference) => reference.filePath), ['src/page.tsx']);
});
