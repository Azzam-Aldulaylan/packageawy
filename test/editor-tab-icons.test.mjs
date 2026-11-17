import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), 'utf8');
const allowlist = read('.vscodeignore').split(/\r?\n/);
const brand = read('webview', 'src', 'icons.tsx').split('export function IconBrand')[1].split('/** Updates Available. */')[0];
const brandPaths = [...brand.matchAll(/\bd="([^"]+)"/g)].map(match => match[1]);

function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

for (const [suffix, backgrounds] of [
  ['', ['#FFFFFF', '#F3F3F3', '#DFE1E5']],
  ['_dark', ['#000000', '#1E1E1E', '#252526', '#2B2D30']],
]) {
  test(`tab logo${suffix} ships at 16px`, () => {
    const filename = `editor-tab${suffix}.svg`;
    assert.ok(allowlist.includes(`!media/${filename}`), `${filename} must ship in the VSIX`);
    const svg = read('media', filename);
    const dom = new JSDOM(svg, { contentType: 'image/svg+xml' });
    try {
      const root = dom.window.document.documentElement;
      assert.equal(root.getAttribute('width'), '16');
      assert.equal(root.getAttribute('height'), '16');
      assert.equal(root.getAttribute('viewBox'), '0 0 24 24');
      assert.equal(root.querySelector('title').textContent, 'Packageawy');
      const paths = [...root.querySelectorAll('path')];
      assert.equal(paths.length, 4);
      assert.deepEqual(paths.map(element => element.getAttribute('d')), brandPaths);
      assert.ok(paths.every(element => element.getAttribute('fill-rule') === 'evenodd'));
      assert.equal(root.querySelector('image, script, use, style'), null, 'logo must be self-contained');
      const foreground = luminance(root.getAttribute('fill'));
      for (const background of backgrounds) {
        const surface = luminance(background);
        const contrast = (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
        assert.ok(contrast >= 3, `${filename} needs 3:1 contrast on ${background}, got ${contrast}`);
      }
    } finally {
      dom.window.close();
    }
  });
}
