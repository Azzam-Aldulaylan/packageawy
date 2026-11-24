import * as path from 'node:path';

import { implicitStylePackages } from '../../core/usage/frameworkConventions.js';
import { importedPackageName } from '../../core/usage/packageNameMatch.js';
import { isStyleLoader, scanStylesheet, styleDialect, styleFileKind } from '../../core/usage/styleScan.js';
import type { StyleDialect, StyleTarget } from '../../core/usage/styleScan.js';
import type { DependencyReference } from '../../core/usage/types.js';
import type { UsageReferenceIndex } from '../../core/usage/referenceIndex.js';
import { relativeToFolder } from './workspaceFiles.js';
import { canonicalPath, isMissingPathError } from '../pathIdentity.js';
import type { WorkspaceFileReadMetrics } from './workspaceFiles.js';
import type { CancellationToken, HostPlatform, WorkspaceFolder } from '../platform/hostPlatform.js';

interface StyleJob { absolutePath: string; filePath: string; text: string; dialect: StyleDialect; target: StyleTarget }
interface ReaderOptions {
  platform: HostPlatform;
  folder: WorkspaceFolder;
  projectRoot: string;
  token: CancellationToken;
  maxFiles: number;
  index: UsageReferenceIndex;
  globalReasons: Set<string>;
  metrics: WorkspaceFileReadMetrics;
  containedPath(absolutePath: string): Promise<string | null>;
  consumeScript(absolutePath: string, filePath: string, text: string, canonical: string): void;
  recordFile(absolutePath: string): void;
}

const validPackage = (name: string): boolean => /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) && !name.startsWith('.');
const expression = (target: string): boolean => /#\{|@\{|\$|[{}]|\bvar\(/.test(target) || /^@[^/]+$/.test(target);
const dynamic = (target: string): boolean => expression(target) || target.includes('*');

/** The innermost node_modules directory owns a resolved file (including scopes). */
function installedPackage(target: string): string | null {
  const parts = target.split('/');
  const modules = parts.lastIndexOf('node_modules');
  if (modules < 0) return null;
  const name = importedPackageName(parts.slice(modules + 1).join('/'));
  return name !== null && validPackage(name) ? name : null;
}

/** Resolve local styles only within the project, including files omitted by discovery. */
export class StylesheetReader {
  readonly packageReasons = new Map<string, Set<string>>();
  private readonly jobs: StyleJob[] = [];
  private readonly read = new Map<string, { text: string | null; unread: boolean }>();
  private readonly lines = new Map<string, { starts: number[]; snippets: Map<number, string> }>();
  private readonly scanned = new Set<string>();
  private followed = 0;
  private readonly localPrefixes = new Map<string, boolean>();
  private readonly protectedDialects = new Set<string>();
  private canonicalFolder: Promise<string | null> | undefined;

  constructor(private readonly options: ReaderOptions) {}

  scan(absolutePath: string, filePath: string, text: string, dialect: StyleDialect): void {
    const key = `${absolutePath}\0${dialect}\0${text}`;
    if (this.scanned.has(key)) return;
    this.scanned.add(key);
    const owner = installedPackage(absolutePath.split(path.sep).join('/'));
    if (owner !== null) {
      this.options.index.addReference(owner, {
        filePath, line: 0, column: 0, snippet: `stylesheet provided by ${owner}`,
        kind: 'config', context: 'stylesheet processing',
      });
    }
    this.protectPreprocessor(filePath, dialect);
    const scan = scanStylesheet(text, dialect);
    if (scan.unread.length > 0) this.options.globalReasons.add(`stylesheet syntax in ${filePath} that could not be read`);
    for (const target of scan.targets) this.jobs.push({ absolutePath, filePath, text, dialect, target });
  }

  protectPreprocessor(filePath: string, dialect: StyleDialect): void {
    const key = `${filePath}\0${dialect}`;
    if (this.protectedDialects.has(key)) return;
    this.protectedDialects.add(key);
    for (const name of implicitStylePackages(dialect)) {
      this.options.index.addReference(name, {
        filePath, line: 0, column: 0, snippet: `${dialect} stylesheet processing`,
        kind: 'config', context: `${dialect} stylesheet processing`,
      });
    }
  }

  addTarget(absolutePath: string, filePath: string, text: string, dialect: StyleDialect, target: StyleTarget): void {
    this.jobs.push({ absolutePath, filePath, text, dialect, target });
  }

  private reason(job: StyleJob, detail: string, packageName?: string): void {
    const reason = `${job.target.directive} target in ${job.filePath} that ${detail}`;
    if (packageName === undefined) this.options.globalReasons.add(reason);
    else {
      const reasons = this.packageReasons.get(packageName) ?? new Set<string>();
      reasons.add(reason);
      this.packageReasons.set(packageName, reasons);
    }
  }

  private reference(job: StyleJob, name: string): void {
    let document = this.lines.get(job.text);
    if (document === undefined) {
      const starts = [0];
      for (let i = 0; i < job.text.length; i += 1) if (job.text[i] === '\n') starts.push(i + 1);
      document = { starts, snippets: new Map() };
      this.lines.set(job.text, document);
    }
    let low = 0;
    let high = document.starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if ((document.starts[mid] ?? 0) <= job.target.offset) low = mid;
      else high = mid;
    }
    const start = document.starts[low] ?? 0;
    let snippet = document.snippets.get(low);
    if (snippet === undefined) {
      snippet = job.text.slice(start, (document.starts[low + 1] ?? job.text.length + 1) - 1).trim().slice(0, 160);
      document.snippets.set(low, snippet);
    }
    const reference: DependencyReference = {
      filePath: job.filePath, line: low + 1, column: job.target.offset - start + 1, snippet, kind: 'import',
    };
    this.options.index.addReference(name, reference);
  }

  private candidates(absolutePath: string, dialect: StyleDialect, script: boolean, directive: string): string[][] {
    if (styleFileKind(directive, dialect) === 'data') return [[absolutePath]];
    if (script) return [absolutePath, ...['.js', '.ts', '.mjs', '.cjs', '.json'].map(ext => absolutePath + ext)].map(file => [file]);
    const extensions = dialect === 'css' ? ['.css', '.pcss', '.postcss']
      : dialect === 'less' ? ['.less', '.css'] : dialect === 'stylus' ? ['.styl', '.stylus', '.css'] : ['.scss', '.sass', '.css'];
    const variants = (file: string): string[] => path.basename(file).startsWith('_') ? [file]
      : [file, path.join(path.dirname(file), `_${path.basename(file)}`)];
    if (dialect === 'scss' || dialect === 'sass') {
      const ext = path.extname(absolutePath);
      const stem = ext ? absolutePath.slice(0, -ext.length) : absolutePath;
      const direct = ext ? variants(absolutePath) : extensions.flatMap(extension => variants(stem + extension));
      const importOnly = (base: string): string[] => (ext ? [ext] : ['.scss', '.sass'])
        .filter(extension => extension !== '.css').flatMap(extension => variants(base + '.import' + extension));
      const groups: string[][] = [];
      if (directive === '@import' && !stem.endsWith('.import')) groups.push(importOnly(stem));
      groups.push(direct);
      if (!ext) {
        if (directive === '@import') groups.push(importOnly(path.join(absolutePath, 'index')));
        groups.push(extensions.flatMap(extension => variants(path.join(absolutePath, 'index' + extension))));
      }
      return groups;
    }
    const partial = path.join(path.dirname(absolutePath), `_${path.basename(absolutePath)}`);
    const candidates = path.extname(absolutePath) ? [absolutePath, partial]
      : [absolutePath, ...extensions.flatMap(ext => [absolutePath + ext, partial + ext]),
        ...extensions.flatMap(ext => [path.join(absolutePath, 'index' + ext), path.join(absolutePath, '_index' + ext)])];
    return candidates.map(file => [file]);
  }

  private async localContent(job: StyleJob, contained: string, candidate: string): Promise<{ text: string | null; unread: boolean }> {
    // Absence affects resolution too: a new preferred candidate can replace a
    // fallback. Record every spelling before stat or a cached miss is returned.
    this.options.recordFile(candidate);
    this.options.recordFile(contained);
    const cached = this.read.get(contained);
    if (cached !== undefined) return cached;
    let content: { text: string | null; unread: boolean };
    try {
      this.options.metrics.onStat?.();
      const stat = await this.options.platform.statFile(contained);
      if (++this.followed > this.options.maxFiles) {
        this.reason(job, 'could not be read within the file limit');
        return { text: null, unread: true };
      }
      if (stat.size > 2 * 1024 * 1024) content = { text: null, unread: true };
      else {
        const bytes = await this.options.platform.readFile(contained);
        this.options.recordFile(contained);
        this.options.metrics.onRead?.(bytes.byteLength);
        content = { text: Buffer.from(bytes).toString('utf8'), unread: false };
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const missing = isMissingPathError(error) || code === 'FileNotFound' || code === 'EISDIR' || code === 'FileIsADirectory';
      content = { text: null, unread: !missing };
    }
    this.read.set(contained, content);
    return content;
  }

  private async readLocal(job: StyleJob, target: string, script: boolean): Promise<boolean> {
    const absolutePath = path.resolve(path.dirname(job.absolutePath), target);
    const dataOnly = styleFileKind(job.target.directive, job.dialect) === 'data';
    for (const group of this.candidates(absolutePath, job.target.dialect ?? job.dialect, script, job.target.directive)) {
      const matches: Array<{ candidate: string; contained: string; text: string }> = [];
      for (const candidate of group) {
        if (this.options.token.isCancellationRequested) return false;
        const contained = await this.options.containedPath(candidate);
        if (contained === null) { this.reason(job, 'could not be resolved within the project'); return true; }
        const content = await this.localContent(job, contained, candidate);
        if (content.unread) { this.reason(job, 'could not be read'); return true; }
        if (content.text !== null) matches.push({ candidate, contained, text: content.text });
      }
      if (matches.length > 1) { this.reason(job, 'has ambiguous Sass candidates'); return true; }
      const match = matches[0];
      if (match === undefined) continue;
      const { candidate, contained, text } = match;
      const owner = installedPackage(contained.split(path.sep).join('/'));
      // drain() already records a package named by the lexical node_modules path.
      if (owner !== null && owner !== installedPackage(path.posix.normalize(target))) this.reference(job, owner);
      let filePath = relativeToFolder(this.options.folder, candidate);
      if (filePath === null) {
        // Canonical source paths may use a different spelling of the workspace
        // itself (for example /var and /private/var on macOS).
        this.canonicalFolder ??= canonicalPath(this.options.folder.path).catch(() => null);
        const root = await this.canonicalFolder;
        if (root !== null) filePath = relativeToFolder({ ...this.options.folder, path: root }, contained);
      }
      if (filePath === null) { this.reason(job, 'could not be resolved within the workspace'); return true; }
      // Prove data files are readable, but never interpret their bytes as code.
      if (dataOnly) return true;
      if (job.target.directive === 'use' && path.extname(candidate) && !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(candidate)) {
        this.reason(job, 'uses an unsupported plugin file type');
      } else if (script) this.options.consumeScript(candidate, filePath, text, contained);
      else {
        const dialect = job.target.dialect ?? styleDialect(candidate);
        if (dialect !== undefined) this.scan(contained, filePath, text, dialect);
        else if (!path.extname(candidate)) this.scan(contained, filePath, text, job.dialect);
        else if (job.target.directive !== 'url') this.reason(job, 'uses an unsupported file type');
      }
      return true;
    }
    return false;
  }

  private async localPrefixExists(job: StyleJob, packageName: string): Promise<boolean> {
    const absolutePath = path.resolve(path.dirname(job.absolutePath), packageName);
    this.options.recordFile(absolutePath);
    const cached = this.localPrefixes.get(absolutePath);
    if (cached !== undefined) return cached;
    let exists = true;
    try {
      const target = await this.options.containedPath(absolutePath);
      if (target !== null) {
        this.options.recordFile(target);
        this.options.metrics.onStat?.();
        await this.options.platform.statFile(target);
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      exists = !isMissingPathError(error) && code !== 'FileNotFound';
    }
    this.localPrefixes.set(absolutePath, exists);
    return exists;
  }

  private async assetPackages(job: StyleJob, target: string): Promise<Set<string>> {
    const files = target.startsWith('/')
      ? [this.options.projectRoot, path.join(this.options.projectRoot, 'public')].map(root => path.resolve(root, `.${target}`))
      : [path.resolve(path.dirname(job.absolutePath), target)];
    const owners = new Set<string>();
    for (const file of files) {
      try {
        this.options.recordFile(file);
        this.options.metrics.onStat?.();
        await this.options.platform.statFile(file);
        const canonical = await canonicalPath(file);
        const owner = installedPackage(canonical.split(path.sep).join('/'));
        if (owner !== null) owners.add(owner);
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (!isMissingPathError(error) && code !== 'FileNotFound') this.reason(job, 'could not be resolved');
      }
    }
    return owners;
  }

  async drain(): Promise<void> {
    let processed = 0;
    for (const job of this.jobs) {
      if (++processed > this.options.maxFiles * 32) {
        this.options.globalReasons.add('stylesheet targets beyond the scan limit');
        break;
      }
      if (this.options.token.isCancellationRequested) break;
      if (job.target.computed) {
        this.reason(job, 'could not be resolved because it uses a variable');
        continue;
      }
      let raw = job.target.target;
      if (/^(?:https?:|data:|ftp:|\/\/|sass:)/i.test(raw) ||
          (job.target.directive === 'url' || job.target.cssImport) && raw.startsWith('#') && !raw.startsWith('#{')) continue;
      if (job.target.directive === 'url') {
        // Strip loader suffixes before decoding so encoded ?/# remain filename characters.
        try { raw = decodeURIComponent(raw.split(/\?|#(?!\{)/, 1)[0] ?? raw); }
        catch { this.reason(job, 'could not be URL-decoded'); continue; }
      }
      const explicitPackage = /^(?:~|pkg:)/.test(raw);
      const target = raw.replace(/^(?:~|pkg:)/, '');
      const normalized = path.posix.normalize(target);
      const traverses = target.split('/').includes('..');
      if (!target.startsWith('.') && !target.startsWith('/') && traverses) {
        this.reason(job, 'could not be resolved within a package');
        continue;
      }
      const installed = installedPackage(normalized);
      if (job.target.directive === '@source' && installed && validPackage(installed)) {
        // Tailwind reads class candidates from this package, including directory/glob sources.
        if (expression(target)) {
          const suffix = target.split('/node_modules/').at(-1) ?? target;
          this.reason(job, 'could not be resolved because it contains an expression', suffix.split('/').includes('..') ? undefined : installed);
        } else this.reference(job, installed);
        continue;
      }
      const packageName = importedPackageName(target.startsWith('.') ? target : normalized);
      if (job.target.directive === 'url' && target !== '' && !dynamic(target)) {
        // Assets are inspected with stat/realpath only, never read as source.
        const owners = !explicitPackage ? await this.assetPackages(job, target) : new Set<string>();
        // A loader may prefer a package over a same-named local asset.
        const name = installed ?? packageName;
        for (const owner of owners) if (owner !== name) this.reference(job, owner);
        if (name !== null && validPackage(name)) this.reference(job, name);
        else if (owners.size === 0 && !target.startsWith('.') && !target.startsWith('/')) this.reason(job, 'could not be resolved');
        continue;
      }
      const sass = job.dialect === 'sass' || job.dialect === 'scss';
      const cssImport = job.target.cssImport || job.target.directive === '@import' && /\.css$/i.test(target);
      const sassModule = ['@use', '@forward', '@import'].includes(job.target.directive) || isStyleLoader(job.target.directive);
      const ambiguous = sass && !explicitPackage && !cssImport && sassModule;
      let bounded = !ambiguous && !traverses && packageName !== null && validPackage(packageName) && target.startsWith(`${packageName}/`);
      if (bounded && !explicitPackage && packageName !== null && await this.localPrefixExists(job, packageName)) bounded = false;
      if (job.target.directive === '@source' && bounded && packageName !== null && !expression(target)) {
        this.reference(job, packageName);
        continue;
      }
      if (dynamic(target)) {
        // Interpolation can introduce separators and traversal even after a package prefix.
        this.reason(job, 'could not be resolved because it contains an expression');
        continue;
      }
      if (target === '') { this.reason(job, 'is empty'); continue; }
      const fileKind = styleFileKind(job.target.directive, job.dialect);
      const script = job.target.directive === '@config' || job.target.directive === '@plugin' || fileKind === 'script';
      const relative = target.startsWith('.') || target.startsWith('/');
      // Prefer local Sass partials before considering a load path or package importer.
      if (!explicitPackage && !target.startsWith('#') && await this.readLocal(job, target, script)) {
        if (installed && validPackage(installed)) this.reference(job, installed);
        else if (!relative && !ambiguous && packageName !== null && validPackage(packageName)) {
          // A loader may prefer a package over a same-named project file.
          this.reference(job, packageName);
        }
        continue;
      }
      if (fileKind !== undefined && installed && validPackage(installed)) this.reference(job, installed);
      const includePath = !explicitPackage && !cssImport && (job.dialect === 'less' || job.dialect === 'stylus') &&
        (['@import', '@require', '@plugin'].includes(job.target.directive) || fileKind !== undefined);
      if (includePath && !relative && packageName !== null && validPackage(packageName)) this.reference(job, packageName);
      if (relative || ambiguous || includePath) {
        this.reason(job, ambiguous ? 'could not be resolved from local files or known load paths' : 'could not be read');
      } else if (packageName !== null && validPackage(packageName)) this.reference(job, packageName);
      else this.reason(job, 'could not be resolved');
    }
  }
}
