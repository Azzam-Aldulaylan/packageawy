import path from 'node:path';
import { analyzeDependencyUsage } from '../../out/host/usage/usageAnalyzer.js';

export const folder = { id: 'file:///workspace', name: 'workspace', path: path.resolve('/workspace') };
export const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

export function usageWorkspace(entries, { hidden = [], manifest = '{}', pathModule = path, workspaceFolder = folder } = {}) {
  const files = new Map(entries);
  const reads = [];
  const chunkReads = [];
  // Entries use portable keys, while the host adapter receives native absolute paths.
  const fileKey = absolutePath => pathModule.relative(workspaceFolder.path, absolutePath).split(pathModule.sep).join('/');
  const platform = {
    async findFiles(search) {
      return [...files.keys()].filter(file => !hidden.includes(file) && pathModule.matchesGlob(file, search.include))
        .map(file => pathModule.resolve(workspaceFolder.path, file)).slice(0, search.maxResults);
    },
    async statFile() { return { size: 100 }; },
    async readFile(absolutePath) {
      const file = fileKey(absolutePath);
      reads.push(file);
      if (!files.has(file) || files.get(file) === null) throw new Error('unreadable');
      return new TextEncoder().encode(files.get(file));
    },
    async *readFileChunks(absolutePath) {
      const file = fileKey(absolutePath);
      if (!files.has(file) || files.get(file) === null) throw new Error('unreadable');
      const bytes = new TextEncoder().encode(files.get(file));
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        const chunk = bytes.subarray(offset, offset + 4096);
        chunkReads.push({ file, bytes: chunk.length });
        yield chunk;
      }
    },
    withProgress: async (_title, run) => run({ report() {} }, token),
  };
  return {
    files, reads, chunkReads, platform,
    analyze: (overrides = {}) => analyzeDependencyUsage({
      platform, folder: workspaceFolder, dir: '', manifestText: manifest, packageNames: ['only-here'], token, ...overrides,
    }),
  };
}
