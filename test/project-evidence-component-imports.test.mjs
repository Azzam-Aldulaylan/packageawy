import assert from 'node:assert/strict';
import test from 'node:test';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { folder, usageWorkspace } from './helpers/usage-coverage.mjs';

for (const extension of ['vue', 'svelte', 'astro']) {
  for (const [attributes, body] of [
    ['', 'import x from "only-here/private";'],
    [' lang="ts"', 'const x = <T>require("only-here/private");'],
    [' lang="jsx"', 'const x = <div>require("only-here/fake"){require("only-here/private")}</div>;'],
    [' lang="tsx"', 'const x = <T extends {}>(x: T) => require("only-here/private"); // </T>'],
  ]) {
    test(`compatibility collector scans ${extension} scripts with ${attributes || 'default language'}`, async () => {
      const filePath = `page.${extension}`;
      const { platform } = usageWorkspace([[filePath, `<script${attributes}>${body}\n</script>`]]);
      const evidence = await collectProjectCompatibilityEvidence({
        platform, folder, dir: '', manifestText: '{}', packageName: 'only-here',
      });
      assert.equal(evidence.truncated, false);
      assert.equal(evidence.scannedFileCount, 1);
      assert.equal(evidence.imports.length, 1);
      assert.equal(evidence.imports[0].specifier, 'only-here/private');
      assert.equal(evidence.imports[0].filePath, filePath);
      assert.equal(evidence.imports[0].line, 1);
      assert.equal(evidence.imports[0].column, `<script${attributes}>${body}`.indexOf('only-here/private') + 1);
    });
  }
}
