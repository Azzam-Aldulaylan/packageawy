// Checks run by the Release workflow before anything is built or published,
// and the release notes it attaches to the GitHub release.
//
//   node scripts/release/release-checks.mjs verify [--pre-release true|false] [--offline]
//   node scripts/release/release-checks.mjs notes [version]
//   node scripts/release/release-checks.mjs version
//
// `verify` fails when package.json's version has no dated changelog section,
// when the tag v<version> is already on the remote, or when the version is
// already on the Marketplace or Open VSX. The two store lookups are best
// effort: when a store cannot be reached the check is skipped with a warning.
// `--offline` skips the tag and store lookups entirely.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const EXTENSION_ID = 'Azzam.packageawy';
export const OPEN_VSX_URL = 'https://open-vsx.org/api/Azzam/packageawy';
const LOOKUP_TIMEOUT_MS = 60_000;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the string is a real calendar date written as YYYY-MM-DD. */
export function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * Finds the `## [x.y.z]` section for a version. Returns its heading date (or
 * undefined when the heading has none) and the text up to the next `## `
 * heading, or undefined when there is no section for that version.
 */
export function findChangelogSection(changelog, version) {
  const lines = changelog.replaceAll('\r\n', '\n').split('\n');
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](.*)$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const rest = heading.exec(lines[start])[1].trim();
  const dateMatch = /^-\s+(\S+)$/.exec(rest);
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end === -1) end = lines.length;
  return {
    date: dateMatch ? dateMatch[1] : undefined,
    body: lines.slice(start + 1, end).join('\n').trim(),
  };
}

/** The release notes for a version: its changelog section without the heading. */
export function extractReleaseNotes(changelog, version) {
  const section = findChangelogSection(changelog, version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  return section.body;
}

/** The Marketplace convention: an odd minor version is a pre-release line. */
export function isPreReleaseMinor(version) {
  const minor = Number(version.split('.')[1]);
  return minor % 2 === 1;
}

/** Tag names from `git ls-remote --tags` output, without peeled `^{}` entries. */
export function parseRemoteTags(lsRemoteOutput) {
  const tags = new Set();
  for (const line of lsRemoteOutput.split('\n')) {
    const ref = line.trim().split(/\s+/)[1];
    if (!ref?.startsWith('refs/tags/')) continue;
    tags.add(ref.slice('refs/tags/'.length).replace(/\^\{\}$/, ''));
  }
  return [...tags];
}

/** Versions listed by `vsce show <id> --json`. */
export function parseMarketplaceVersions(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(data?.versions)) throw new Error('vsce show returned no versions list.');
  return data.versions.map((entry) => entry.version).filter((version) => typeof version === 'string');
}

/** Versions listed by the Open VSX extension endpoint. */
export function parseOpenVsxVersions(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const versions = new Set();
  if (typeof data?.version === 'string') versions.add(data.version);
  for (const key of Object.keys(data?.allVersions ?? {})) {
    if (VERSION_PATTERN.test(key)) versions.add(key);
  }
  return [...versions];
}

/**
 * Pure decision over everything the checks gathered. Each remote list is
 * either an array of versions or tags, or undefined when it was not looked
 * up (offline) or could not be reached. Returns the errors that stop the
 * release, warnings, and informational lines.
 */
export function evaluateRelease({ version, changelog, preRelease, remoteTags, marketplaceVersions, openVsxVersions }) {
  const errors = [];
  const warnings = [];
  const info = [];

  if (!VERSION_PATTERN.test(version ?? '')) {
    errors.push(`package.json version "${version}" is not a plain x.y.z version.`);
    return { ok: false, errors, warnings, info };
  }

  const section = findChangelogSection(changelog, version);
  if (!section) {
    errors.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section.`);
  } else if (!section.date) {
    errors.push(`The CHANGELOG.md section for ${version} has no date. Write it as "## [${version}] - YYYY-MM-DD".`);
  } else if (!isValidDate(section.date)) {
    errors.push(`The CHANGELOG.md date for ${version} is "${section.date}", which is not a YYYY-MM-DD date.`);
  } else if (!section.body) {
    errors.push(`The CHANGELOG.md section for ${version} is empty.`);
  } else {
    info.push(`CHANGELOG.md has a section for ${version} dated ${section.date}.`);
  }

  if (preRelease !== undefined && isPreReleaseMinor(version) !== preRelease) {
    warnings.push(
      preRelease
        ? `${version} has an even minor version, which the release checklist keeps for stable releases.`
        : `${version} has an odd minor version, which the release checklist keeps for pre-releases.`
    );
  }

  const tag = `v${version}`;
  if (remoteTags === undefined) {
    warnings.push(`Skipped the remote tag check for ${tag}.`);
  } else if (remoteTags.includes(tag)) {
    errors.push(`The tag ${tag} already exists on the remote.`);
  } else {
    info.push(`The tag ${tag} is not on the remote yet.`);
  }

  if (marketplaceVersions === undefined) {
    warnings.push('Skipped the Marketplace version check because the Marketplace could not be reached.');
  } else if (marketplaceVersions.includes(version)) {
    errors.push(`${version} is already published on the Marketplace.`);
  } else {
    info.push(`${version} is not on the Marketplace yet.`);
  }

  if (openVsxVersions === undefined) {
    warnings.push('Skipped the Open VSX version check because Open VSX could not be reached.');
  } else if (openVsxVersions.includes(version)) {
    errors.push(`${version} is already published on Open VSX.`);
  } else {
    info.push(`${version} is not on Open VSX yet.`);
  }

  return { ok: errors.length === 0, errors, warnings, info };
}

async function readPackageVersion() {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

async function readChangelog() {
  return readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8');
}

async function lookUpRemoteTags(tag) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
      cwd: repositoryRoot,
      timeout: LOOKUP_TIMEOUT_MS,
    });
    return parseRemoteTags(stdout);
  } catch (error) {
    console.log(`Could not list remote tags: ${error.message}`);
    return undefined;
  }
}

async function lookUpMarketplaceVersions() {
  const vsce = path.join(repositoryRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
  try {
    const { stdout } = await execFileAsync(process.execPath, [vsce, 'show', EXTENSION_ID, '--json'], {
      cwd: repositoryRoot,
      timeout: LOOKUP_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseMarketplaceVersions(stdout);
  } catch (error) {
    console.log(`Could not read ${EXTENSION_ID} from the Marketplace: ${error.message.split('\n')[0]}`);
    return undefined;
  }
}

async function lookUpOpenVsxVersions() {
  try {
    const response = await fetch(OPEN_VSX_URL, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseOpenVsxVersions(await response.json());
  } catch (error) {
    console.log(`Could not read ${OPEN_VSX_URL}: ${error.message}`);
    return undefined;
  }
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// GitHub Actions turns these prefixes into annotations on the run summary.
const inActions = process.env['GITHUB_ACTIONS'] === 'true';
function report(kind, message) {
  if (inActions && kind !== 'info') console.log(`::${kind}::${message}`);
  else console.log(`${kind === 'info' ? 'ok' : kind}: ${message}`);
}

async function verify(args) {
  const preReleaseFlag = readFlag(args, '--pre-release');
  const preRelease = preReleaseFlag === undefined ? undefined : preReleaseFlag === 'true';
  const offline = args.includes('--offline');
  const version = await readPackageVersion();
  const changelog = await readChangelog();
  const [remoteTags, marketplaceVersions, openVsxVersions] = offline
    ? [undefined, undefined, undefined]
    : await Promise.all([lookUpRemoteTags(`v${version}`), lookUpMarketplaceVersions(), lookUpOpenVsxVersions()]);

  const result = evaluateRelease({ version, changelog, preRelease, remoteTags, marketplaceVersions, openVsxVersions });
  for (const line of result.info) report('info', line);
  for (const line of result.warnings) report('warning', line);
  for (const line of result.errors) report('error', line);
  if (!result.ok) process.exit(1);
  console.log(`Release checks passed for ${version}.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify') return verify(args);
  if (command === 'version') return console.log(await readPackageVersion());
  if (command === 'notes') {
    const version = args[0] ?? (await readPackageVersion());
    return console.log(extractReleaseNotes(await readChangelog(), version));
  }
  console.error('Usage: node scripts/release/release-checks.mjs verify|notes|version');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
