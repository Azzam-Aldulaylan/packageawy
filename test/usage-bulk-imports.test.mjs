import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnreadTemplateImports as checkUnread, scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

// Parser unit tests supply a successful host proof; integration tests below use real proof.
const hasUnreadTemplateImports = (text, filePath, language, dir = '') => checkUnread(text, filePath, language, dir, () => true);

const file = 'packages/app/src/components/forms/page.tsx';
const project = 'packages/app';
const context = dir => `require.context(${JSON.stringify(dir)}, true, /\\.json$/)`;
const glob = pattern => `import.meta.glob(${JSON.stringify(pattern)})`;
const specs = source => scanSourceForImportSpecifiers(source, file).map(match => match.specifier);
const localCalls = [
  'require.context(".")', 'require.context("..")',
  context('../../../locales/'), 'require.context("./locales")',
  'require.context("./locales", false)', 'require.context("./locales", true, /[/*]\\/x/i)',
  'require /* a */ . /* b */ context ( "./locales", true, /\\.json$/, )',
  'import.meta.glob([])', 'import.meta.glob([], {})',
  glob('./locales/*.json'), glob('/locales/**/*.json'), glob('../../../locales/*.json'),
  'import.meta.glob(["./en/*.json", "/locales/ar/*.json"], { eager: true, import: "default", query: { lang: "json", raw: "" } })',
  'import.meta.glob("./*.json", { exhaustive: false, query: "?raw" },)',
];
for (const call of localCalls) {
  test(`static project-local bulk loader stays covered: ${call}`, () => {
    const source = `const context = ${call}; import "after";`;
    assert.equal(hasUnreadTemplateImports(source, file, undefined, project), false, source);
    assert.deepEqual(specs(source), ['after']);
  });
}

const packageCalls = [
  [context('some-pkg/locales'), 'some-pkg/locales', 'some-pkg'],
  [context('@scope/pkg/locales'), '@scope/pkg/locales', '@scope/pkg'],
  [context('../../../node_modules/some-pkg/locales'), 'some-pkg/locales', 'some-pkg'],
  [context('/workspace/node_modules/@scope/pkg/locales'), '@scope/pkg/locales', '@scope/pkg'],
  [glob('/node_modules/some-pkg/locales/*.json'), 'some-pkg/locales/*.json', 'some-pkg'],
  [glob('./node_modules/@scope/pkg/*.json'), '@scope/pkg/*.json', '@scope/pkg'],
];
for (const [call, specifier, packageName] of packageCalls) {
  test(`bulk loader records package directory: ${call}`, () => {
    assert.equal(hasUnreadTemplateImports(call, file, undefined, project), false, call);
    const matches = scanSourceForImportSpecifiers(call, file);
    assert.deepEqual(matches.map(match => [match.specifier, match.packageName]), [[specifier, packageName]]);
    const match = matches[0];
    assert.equal(call.slice(match.column - 1, match.column - 1 + packageName.length), packageName);
  });
}

test('non-static, escaping and unsupported bulk loaders stay unread', () => {
  for (const call of [
    context('../../../../locales'), context('../../../../app-other/locales'), 'require.context("../../../..")',
    glob('../../../../locales/*.json'), glob('/../outside/*.json'),
    'require.context(directory)', 'require.context("./locales" + suffix)',
    'require.context("./locales", recurse)', 'require.context("./locales", true, expression)',
    'require.context("./locales", true, /x/, mode)',
    'require.context("./locales", true, /x/ + suffix)',
    'import.meta.glob(pattern)', 'import.meta.glob(["./locales/*", pattern])',
    'import.meta.glob("./locales/*", options)', 'import.meta.glob("./*", { ...options })',
    'import.meta.glob("./*", { eager: compute() })', 'import.meta.glob("some-pkg/*.json")',
    'import.meta.glob("./*.json", { custom: [1, -2, null, { a: true }] })',
    'import.meta.glob(["./locales/*", "../../../../outside/*"])',
    'import.meta.glob(`./${name}/*.json`)', 'require.context(`./${name}`)',
    'require.context("./node_modules/" + name)', 'import.meta.glob("./node_modules/*/*.js")',
    'require.context("./node_modules/pkg/../../real")',
    'require.context("./node_modules/")', 'import.meta.glob("./**/node_modules/*")',
    'import.meta.glob("./{locales,node_modules}/*")',
    'import.meta.glob("./*/../../../../outside/*")',
    'import.meta.glob("./{..,x}/{..,x}/{..,x}/{..,x}/outside/*")',
    'import.meta.glob("./node_modules/pkg/{..,x}/{..,x}/real/*")',
    'import.meta.glob("./*", { eager: true }' ,
    'require.context("./locales", ' + ' '.repeat(4100) + 'true)',
  ]) assert.equal(hasUnreadTemplateImports(call, file, undefined, project), true, call);
  assert.equal(hasUnreadTemplateImports('require.context("./locales")'), true, 'no file boundary');
});

test('bulk loader parsing cannot hide nested executable calls', () => {
  for (const source of [
    'require.context("./locales", require("real"))',
    'import.meta.glob("./*", { eager: require("real") })',
    'import.meta.glob(["./*", import("real")])',
    'require.context(`./${require("real")}`)',
    'import.meta.glob(`./${require("real")}`)',
  ]) {
    assert.equal(hasUnreadTemplateImports(source, file, undefined, project), true, source);
    assert.deepEqual(specs(source), ['real'], source);
  }
  const source = '<A // x\n b={require.context("./locales")} c={require("real")} />';
  assert.equal(hasUnreadTemplateImports(source, file, undefined, project), false);
  assert.deepEqual(specs(source), ['real']);
});

test('bulk loaders honor monorepo project boundaries in usage and compatibility', async () => {
  for (const [call, complete] of [[context('../../../locales/'), true], [context('../../../../other/locales'), false]]) {
    const source = `const context = ${call}; import "only-here";`;
    const workspace = usageWorkspace([[file, source]]);
    const usage = (await workspace.analyze({ dir: project })).get('only-here');
    assert.equal(usage.truncated, !complete, source);
    assert.equal(usage.references.length, 1);
    const evidence = await collectProjectCompatibilityEvidence({
      platform: workspace.platform, folder: { id: 'file:///workspace', name: 'workspace', path: '/workspace' },
      dir: project, manifestText: '{}', packageName: 'only-here',
    });
    assert.equal((evidence.scanLimitations ?? []).includes('project-source-import-scan-incomplete'), !complete, source);
    assert.equal(evidence.imports.length, 1);
  }
});

test('package bulk loaders retain usage and compatibility references', async () => {
  const source = 'const context = require.context("only-here/locales", true, /\\.json$/);';
  const workspace = usageWorkspace([[file, source]]);
  const usage = (await workspace.analyze({ dir: project })).get('only-here');
  assert.equal(usage.truncated, false);
  assert.equal(usage.references.length, 1);
  const evidence = await collectProjectCompatibilityEvidence({
    platform: workspace.platform, folder: { id: 'file:///workspace', name: 'workspace', path: '/workspace' },
    dir: project, manifestText: '{}', packageName: 'only-here',
  });
  assert.equal(evidence.imports[0].specifier, 'only-here/locales');
  assert.equal((evidence.scanLimitations ?? []).includes('project-source-import-scan-incomplete'), false);
});
