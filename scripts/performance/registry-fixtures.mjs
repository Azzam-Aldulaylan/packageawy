import { performance } from 'node:perf_hooks';

export const REGISTRY = 'https://registry.benchmark.invalid';
const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
export const SIZES = [
  { name: 'Small', direct: 15, transitivePerDirect: 2, vulnerableEvery: 5 },
  { name: 'Medium', direct: 50, transitivePerDirect: 4, vulnerableEvery: 5 },
  { name: 'Large', direct: 125, transitivePerDirect: 8, vulnerableEvery: 5 },
  { name: 'XL', direct: 150, transitivePerDirect: 8, vulnerableEvery: 5 },
];

export function fixture({ direct, transitivePerDirect, vulnerableEvery, exactPins = false }) {
  const dependencies = {};
  const packages = { '': { name: 'benchmark-project', version: '1.0.0', dependencies } };
  const vulnerable = new Set();

  for (let index = 0; index < direct; index += 1) {
    const name = `fixture-pkg-${String(index).padStart(3, '0')}`;
    dependencies[name] = exactPins ? '1.0.0' : '^1.0.0';
    if (Number.isFinite(vulnerableEvery) && index % vulnerableEvery === 0) vulnerable.add(name);
    const childDependencies = {};
    for (let child = 0; child < transitivePerDirect; child += 1) {
      const childName = `fixture-child-${String(index).padStart(3, '0')}-${String(child).padStart(2, '0')}`;
      childDependencies[childName] = '^1.0.0';
      packages[`node_modules/${name}/node_modules/${childName}`] = { version: '1.0.0' };
    }
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      ...(transitivePerDirect === 0 ? {} : { dependencies: childDependencies }),
    };
  }

  return {
    registry: exactPins ? 'https://registry.npmjs.org/' : REGISTRY,
    manifestText: JSON.stringify({
      name: 'benchmark-project',
      version: '1.0.0',
      dependencies,
    }),
    lockfileText: JSON.stringify({
      name: 'benchmark-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages,
    }),
    vulnerable,
    graphNodes: Object.keys(packages).length - 1,
  };
}

function response(body, etag) {
  const text = JSON.stringify(body);
  return {
    status: 200,
    headers: etag === undefined ? {} : { etag },
    body: text,
    wireBytes: Buffer.byteLength(text),
  };
}

export function delay(milliseconds) {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function fakeAdapters(fixtureData, latency) {
  const calls = [];
  const events = [];
  let inFlightPackuments = 0;
  let peakPackuments = 0;

  const client = {
    calls,
    events,
    get peakPackuments() {
      return peakPackuments;
    },
    async get(url, options = {}) {
      const path = new URL(url).pathname.split('/').filter(Boolean);
      const kind = url.endsWith('/latest') ? 'latest' : path.length === 2 ? 'exact-version' : 'packument';
      const call = { method: 'GET', kind, url, wireBytes: 0 };
      calls.push(call);
      events.push({ event: 'start', kind, at: performance.now() });
      if (kind === 'packument') {
        inFlightPackuments += 1;
        peakPackuments = Math.max(peakPackuments, inFlightPackuments);
      }
      await delay(kind === 'latest' ? latency.latest : latency.packument);
      if (kind === 'packument') inFlightPackuments -= 1;
      events.push({ event: 'end', kind, at: performance.now() });
      const result = kind === 'latest'
        ? response({ version: '1.2.0', license: 'MIT' }, '"latest"')
        : kind === 'exact-version'
          ? response({ name: decodeURIComponent(path[0]), version: decodeURIComponent(path[1]) }, '"exact"')
          : response({
            'dist-tags': { latest: '1.2.0' },
            versions: { '1.0.0': {}, '1.0.1': {}, '1.1.0': {}, '1.2.0': {} },
          }, '"packument"');
      if (options.headers?.['if-none-match'] === result.headers.etag) {
        return { status: 304, headers: result.headers, body: '', wireBytes: 0 };
      }
      call.wireBytes = result.wireBytes;
      return result;
    },
    async post(url) {
      const call = { method: 'POST', kind: 'advisories', url, wireBytes: 0 };
      calls.push(call);
      events.push({ event: 'start', kind: 'advisories', at: performance.now() });
      await delay(latency.advisories);
      const advisories = {};
      for (const name of fixtureData.vulnerable) {
        advisories[name] = [{
          id: `benchmark-${name}`,
          severity: 'high',
          title: 'Deterministic benchmark advisory',
          url: 'https://example.invalid/advisory',
          vulnerable_versions: '<1.0.1',
        }];
      }
      events.push({ event: 'end', kind: 'advisories', at: performance.now() });
      if (url !== BULK) throw new Error(`unexpected POST ${url}`);
      const result = response(advisories);
      call.wireBytes = result.wireBytes;
      return result;
    },
  };

  const auditRunner = {
    calls: 0,
    async run() {
      this.calls += 1;
      events.push({ event: 'start', kind: 'audit', at: performance.now() });
      await delay(latency.audit);
      events.push({ event: 'end', kind: 'audit', at: performance.now() });
      return {
        stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }),
        exitCode: 0,
      };
    },
  };

  return { client, auditRunner };
}

export const PUBLIC_BEHIND_PINS = { name: 'public-behind-pins', direct: 15, transitivePerDirect: 0, vulnerableEvery: Infinity, exactPins: true };
