/**
 * Builds ThirdPartyNotices.txt from the packages esbuild actually bundled.
 *
 * The extension, sidecar and webview bundles carry copies of runtime
 * dependencies (semver, js-yaml, ini, react, react-dom and what they pull in), and
 * their licenses ask for the notice to travel with every copy. Reading the
 * esbuild metafile keeps the list exact: a package appears only when some of
 * its code made it into an output file.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const NOTICES_FILENAME = 'ThirdPartyNotices.txt';

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;
const SEPARATOR = '-'.repeat(80);

/** `node_modules/@scope/name/lib/x.js` to `node_modules/@scope/name`, using the innermost node_modules. */
function packageDirOf(inputPath) {
  const parts = inputPath.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at === -1 || at + 1 >= parts.length) return undefined;
  const nameLength = parts[at + 1].startsWith('@') ? 2 : 1;
  if (at + nameLength >= parts.length) return undefined;
  return parts.slice(0, at + 1 + nameLength).join('/');
}

/** Package directories (relative to `cwd`) that contributed bytes to any output. */
export function bundledPackageDirs(metafiles) {
  const dirs = new Set();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        if (bytesInOutput === 0) continue;
        const dir = packageDirOf(input);
        if (dir !== undefined) dirs.add(dir);
      }
    }
  }
  return [...dirs];
}

function repositoryUrl(manifest) {
  const repo = manifest.repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  if (typeof url !== 'string') return undefined;
  // npm shorthand: `owner/repo` or `github:owner/repo` both mean GitHub.
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (shorthand !== null) return `https://github.com/${shorthand[1]}`;
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

export function readPackageNotice(packageDir) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const licenseFile = readdirSync(packageDir).filter((name) => LICENSE_FILE.test(name)).sort()[0];
  if (licenseFile === undefined) {
    throw new Error(`${manifest.name}@${manifest.version} is bundled but ships no LICENSE file. Add its notice by hand before releasing.`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : 'see license text',
    url: repositoryUrl(manifest) ?? (typeof manifest.homepage === 'string' ? manifest.homepage : undefined),
    text: readFileSync(path.join(packageDir, licenseFile), 'utf8').replace(/\r\n/g, '\n').trim(),
  };
}

export function renderThirdPartyNotices(notices) {
  // The same version can be bundled from two directories (a nested copy).
  const unique = new Map(notices.map((notice) => [`${notice.name}@${notice.version}`, notice]));
  const sorted = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const sections = sorted.map((notice) => [
    SEPARATOR,
    `${notice.name} ${notice.version} (${notice.license})`,
    ...(notice.url === undefined ? [] : [notice.url]),
    '',
    notice.text,
  ].join('\n'));
  return [
    'Packageawy includes the following third-party software.',
    'Each component is used under its own license, reproduced in full below.',
    '',
    ...sections,
    SEPARATOR,
    '',
  ].join('\n');
}

/** Write the notices for the given esbuild metafiles into `outFile`. */
export function writeThirdPartyNotices(metafiles, outFile, cwd = process.cwd()) {
  const notices = bundledPackageDirs(metafiles).map((dir) => readPackageNotice(path.resolve(cwd, dir)));
  writeFileSync(outFile, renderThirdPartyNotices(notices));
  return notices;
}
