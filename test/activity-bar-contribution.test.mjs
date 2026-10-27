import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes;

test('the Activity Bar container has a view and an icon that ships in the package', () => {
  const container = contributes.viewsContainers.activitybar.find((entry) => entry.id === 'packageawy');
  assert.ok(container, 'missing Activity Bar container');
  assert.ok(existsSync(join(root, container.icon)), `icon file ${container.icon} does not exist`);
  const allowlist = readFileSync(join(root, '.vscodeignore'), 'utf8').split('\n');
  assert.ok(allowlist.includes(`!${container.icon}`), 'the icon is not in the .vscodeignore allowlist, so it would not ship');

  const views = contributes.views[container.id];
  assert.ok(views?.some((view) => view.id === 'packageawy.home'), 'the container has no packageawy.home view');
});

test('the welcome view only links to commands the extension contributes', () => {
  const welcome = contributes.viewsWelcome.find((entry) => entry.view === 'packageawy.home');
  assert.ok(welcome, 'missing welcome content for the sidebar view');
  const linked = [...welcome.contents.matchAll(/\(command:([\w.]+)\)/g)].map((match) => match[1]);
  const declared = new Set(contributes.commands.map((command) => command.command));
  assert.deepEqual(linked, ['packageawy.open', 'packageawy.refresh']);
  for (const command of linked) assert.ok(declared.has(command), `${command} is not a contributed command`);
});
