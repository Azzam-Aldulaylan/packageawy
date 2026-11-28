import { readFile } from 'node:fs/promises';

const expectedTests = [
  'shared result keeps check statuses beside commands at narrow and wide widths',
  'keyboard-focused security card still allows pointer help',
  'dialog footer controls fit short and narrow viewports in both host themes',
  'bulk summary fits the capped dialog at wide and narrow viewport widths',
  'dependency findings keep reading order, aligned edges and group spacing at 1100px and 400px in both host themes',
];

try {
  const tap = await readFile('test-results.tap', 'utf8');
  const passed = new Set();
  for (const line of tap.split(/\r?\n/)) {
    const match = /^ok \d+ - (.+)$/.exec(line);
    if (match) passed.add(match[1]);
  }
  // Exact names exclude TAP skip and todo directives too.
  const missing = expectedTests.filter(name => !passed.has(name));
  if (missing.length) {
    throw new Error(`Required browser tests did not pass without skipping:\n${missing.join('\n')}`);
  }
  console.log(`All ${expectedTests.length} required browser tests ran and passed.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
