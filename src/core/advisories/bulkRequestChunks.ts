import { FetchError } from '../registry/http.js';

const MAX_PACKAGES = 500;
const MAX_BYTES = 256 * 1024;

/** Bound the actual UTF-8 JSON body, including braces, commas and escaped names. */
export function splitBulkRequestBody(body: Record<string, string[]>): Array<Record<string, string[]>> {
  const chunks: Array<Record<string, string[]>> = [];
  let entries: Array<[string, string[]]> = [];
  let bytes = 2;
  for (const [name, versions] of Object.entries(body)) {
    const entryBytes = Buffer.byteLength(JSON.stringify({ [name]: versions }), 'utf8') - 2;
    // Keep a package's versions together. An oversized entry leaves the check
    // unavailable rather than dispatching an unbounded request or omitting versions.
    if (entryBytes + 2 > MAX_BYTES) {
      throw new FetchError('TOO_LARGE', 'Package advisory request exceeds the request size budget.');
    }
    if (entries.length === MAX_PACKAGES || bytes + entryBytes + (entries.length > 0 ? 1 : 0) > MAX_BYTES) {
      chunks.push(Object.fromEntries(entries));
      entries = [];
      bytes = 2;
    }
    bytes += entryBytes + (entries.length > 0 ? 1 : 0);
    entries.push([name, versions]);
  }
  if (entries.length > 0) chunks.push(Object.fromEntries(entries));
  return chunks;
}
