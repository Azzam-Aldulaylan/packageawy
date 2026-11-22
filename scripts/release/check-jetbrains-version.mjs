// Retry guard for JetBrains publication. Any lookup failure stops publication.
// Run: node scripts/release/check-jetbrains-version.mjs <version>
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 35704;
const PLUGIN_XML_ID = 'io.github.azzamaldulaylan.packageawy';

export async function hasJetBrainsVersion(version, fetchImpl = fetch) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Expected a plain x.y.z version.');

  // The official REST client's getUpdatesByVersionAndFamily endpoint searches
  // by XML ID and version across channels, without the recent-updates page limit.
  // https://plugins.jetbrains.com/docs/marketplace/plugin-repository-rest-client.html
  const url = new URL(`https://plugins.jetbrains.com/api/plugins/${PLUGIN_XML_ID}/updates`);
  url.searchParams.set('version', version);
  url.searchParams.set('family', 'intellij');
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`JetBrains Marketplace lookup failed: HTTP ${response.status}.`);
  const updates = await response.json();
  if (!Array.isArray(updates) || updates.some((update) =>
    update?.pluginId !== PLUGIN_ID || typeof update.version !== 'string'
  )) {
    throw new Error('JetBrains Marketplace returned an invalid updates list.');
  }
  // Pending review, hidden and unlisted uploads also count when the API shows them.
  return updates.some((update) => update.version === version);
}

async function main() {
  const version = process.argv[2];
  const exists = await hasJetBrainsVersion(version);
  if (exists) {
    console.log(`::notice::JetBrains Marketplace already has ${PLUGIN_XML_ID} ${version}. Skipping publication.`);
  } else {
    console.log(`JetBrains Marketplace does not have ${PLUGIN_XML_ID} ${version}.`);
  }
  if (process.env['GITHUB_OUTPUT']) {
    await appendFile(process.env['GITHUB_OUTPUT'], `exists=${exists}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
