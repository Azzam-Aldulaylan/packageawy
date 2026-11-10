// Reads a packaged VSIX (a zip file) and checks that it ships what users need
// and nothing they should not get. Run it directly against a .vsix:
//
//   node scripts/integration/check-vsix-contents.mjs packageawy-0.9.4.vsix
//
// The zip reader is small and dependency free on purpose: the check has to
// read the exact archive vsce produced, not the files vsce would pick from
// the working tree (that is what `vsce ls` reports).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const REQUIRED_ENTRIES = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/webview.js',
  'extension/dist/ThirdPartyNotices.txt',
];

const FORBIDDEN_RULES = [
  { reason: 'source map', test: (name) => name.endsWith('.map') },
  { reason: 'source folder', test: (name) => hasSegment(name, 'src') },
  { reason: 'test folder', test: (name) => hasSegment(name, 'test') },
  { reason: 'node_modules folder', test: (name) => hasSegment(name, 'node_modules') },
];

function hasSegment(name, segment) {
  return name.split('/').slice(0, -1).includes(segment);
}

/**
 * Pure check over a list of archive entry names, so it can be unit tested
 * with fake lists. Returns the missing required entries and the entries that
 * must not ship, each with the rule that matched.
 */
export function checkVsixEntries(entryNames) {
  const names = entryNames.map((name) => name.replaceAll('\\', '/'));
  const present = new Set(names);
  const missing = REQUIRED_ENTRIES.filter((required) => !present.has(required));
  const forbidden = [];
  for (const name of names) {
    const rule = FORBIDDEN_RULES.find((candidate) => candidate.test(name));
    if (rule) forbidden.push({ name, reason: rule.reason });
  }
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

/** Parses the zip central directory. Returns entries with their local offsets. */
export function readZipDirectory(buffer) {
  // The end of central directory record sits in the last 65,557 bytes.
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file: end of central directory record not found.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Corrupt zip central directory at byte ${offset}.`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Returns the uncompressed bytes of one archive entry. */
export function readZipEntry(buffer, entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`Corrupt zip local header for ${entry.name}.`);
  }
  const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}.`);
}

export async function readVsix(vsixPath) {
  const buffer = await readFile(vsixPath);
  const entries = readZipDirectory(buffer);
  const manifestEntry = entries.find((entry) => entry.name === 'extension/package.json');
  const manifest = manifestEntry ? JSON.parse(readZipEntry(buffer, manifestEntry).toString('utf8')) : undefined;
  return { entries: entries.map((entry) => entry.name), manifest };
}

async function main() {
  const vsixPath = process.argv[2];
  if (!vsixPath) {
    console.error('Usage: node scripts/integration/check-vsix-contents.mjs <path-to.vsix>');
    process.exit(2);
  }
  const { entries } = await readVsix(vsixPath);
  console.log(`${path.basename(vsixPath)}: ${entries.length} entries`);
  for (const name of entries) console.log(`  ${name}`);
  const result = checkVsixEntries(entries);
  for (const name of result.missing) console.error(`Missing required file: ${name}`);
  for (const { name, reason } of result.forbidden) console.error(`Must not ship (${reason}): ${name}`);
  if (!result.ok) process.exit(1);
  console.log('VSIX contents check passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
