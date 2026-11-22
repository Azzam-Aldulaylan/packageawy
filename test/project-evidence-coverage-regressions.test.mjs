import assert from 'node:assert/strict';
import test from 'node:test';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { folder, usageWorkspace } from './helpers/usage-coverage.mjs';

const cases = [
  ['JS call beyond scanner bound', 'page.js', `require(${' '.repeat(4096)}"only-here/private");`, 'project-source-import-scan-incomplete'],
  ['TS export beyond scanner bound', 'page.ts', `export {${' x,'.repeat(1400)} y} from "only-here/private";`, 'project-source-import-scan-incomplete'],
  ['TSX generic beyond scanner bound', 'page.tsx', `const f=<T${' '.repeat(4094)}extends {}>(x:T)=>require("only-here/private"); // </T>`, 'project-source-import-scan-incomplete'],
  ['Vue TSX template literal constraint', 'page.vue', '<script lang="tsx">const f=<T extends `foo`>(x:T)=>require("only-here/private"); // </T></script>', 'project-source-import-scan-incomplete'],
  ['Svelte template expression', 'page.svelte', '{#await import("only-here/private")}loading{/await}', 'project-source-extraction-incomplete'],
  ['Astro template expression', 'page.astro', '{await import("only-here/private")}', 'project-source-extraction-incomplete'],
  ['Astro frontmatter division', 'page.astro', '---\nconst n=4/2;\nimport x from "only-here/private";\n---\n<div />', 'project-source-extraction-incomplete'],
];

for (const [name, filePath, text, limitation] of cases) {
  test(`compatibility coverage accounts for ${name}`, async () => {
    const workspace = usageWorkspace([[filePath, text]]);
    const evidence = await collectProjectCompatibilityEvidence({
      platform: workspace.platform, folder, dir: '', manifestText: '{}', packageName: 'only-here',
    });
    const usage = (await workspace.analyze()).get('only-here');
    assert.equal(evidence.scannedFileCount, 1);
    assert.ok(evidence.imports.every(reference => reference.specifier === 'only-here/private'));
    if (usage.references.length > 0) assert.equal(evidence.imports.length, usage.references.length);
    if (evidence.imports.length === 0) {
      assert.equal(evidence.truncated, true);
      assert.ok(evidence.scanLimitations?.includes(limitation));
    }
  });
}

for (const [filePath, text, limitation] of [
  ['page.js', 'import "only-here/private"; require(name);', 'project-source-import-scan-incomplete'],
  ['page.svelte', '<script>import "only-here/private";</script>{#await import(name)}loading{/await}', 'project-source-extraction-incomplete'],
]) {
  test(`incomplete coverage retains references already found in ${filePath}`, async () => {
    const { platform } = usageWorkspace([[filePath, text]]);
    const evidence = await collectProjectCompatibilityEvidence({
      platform, folder, dir: '', manifestText: '{}', packageName: 'only-here',
    });
    assert.equal(evidence.truncated, true);
    assert.deepEqual(evidence.scanLimitations, [limitation]);
    assert.equal(evidence.imports.length, 1);
    assert.equal(evidence.imports[0].specifier, 'only-here/private');
  });
}
