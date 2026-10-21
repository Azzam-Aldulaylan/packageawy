import { scanSourceForImports } from './importScan.js';
import { typesPackageTarget } from './packageNameMatch.js';
import type { DependencyReference } from './types.js';

export type ImportScanner = typeof scanSourceForImports;

/**
 * Buckets all requested package references while each source file is parsed
 * exactly once, regardless of how many direct dependencies cleanup analyzes.
 *
 * An import of `react` also counts for a requested `@types/react`, since
 * TypeScript loads those types for that import.
 */
export class UsageReferenceIndex {
  private readonly requested: ReadonlySet<string>;
  private readonly references = new Map<string, DependencyReference[]>();
  private readonly typesPackagesByTarget = new Map<string, string[]>();

  constructor(
    packageNames: readonly string[],
    private readonly scan: ImportScanner = scanSourceForImports
  ) {
    this.requested = new Set(packageNames);
    for (const name of this.requested) {
      this.references.set(name, []);
      const target = typesPackageTarget(name);
      if (target === null) continue;
      const entries = this.typesPackagesByTarget.get(target);
      if (entries === undefined) this.typesPackagesByTarget.set(target, [name]);
      else entries.push(name);
    }
  }

  addSourceFile(filePath: string, text: string): void {
    for (const match of this.scan(text)) {
      const owners = this.typesPackagesByTarget.get(match.packageName) ?? [];
      if (!this.requested.has(match.packageName) && owners.length === 0) continue;
      const reference: DependencyReference = {
        filePath,
        line: match.line,
        column: match.column,
        snippet: match.snippet,
        kind: match.kind,
      };
      this.references.get(match.packageName)?.push(reference);
      for (const owner of owners) this.references.get(owner)?.push({ ...reference });
    }
  }

  addReference(packageName: string, reference: DependencyReference): void {
    this.references.get(packageName)?.push(reference);
  }

  forPackage(packageName: string): DependencyReference[] {
    return this.references.get(packageName) ?? [];
  }
}
