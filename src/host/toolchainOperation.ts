/** Owns discovery only for one analysis, apply or reinstall. Callers pass it to each step. */
import type { NpmResolutionResult } from './npmResolver.js';
import { createNodeNpmResolverAsyncDeps, resolveNpmInvocationAsync, throwIfAborted } from './npmResolverAsync.js';
import { resolveInstalledPnpmInvocationAsync } from './pnpmResolverAsync.js';
import type { PackageManagerInvocation } from './resolverVerifier.js';

export class ToolchainOperation {
  private npmLookup: Promise<NpmResolutionResult> | undefined;
  private readonly invocations = new Map<'npm' | 'pnpm', Promise<PackageManagerInvocation | null>>();

  constructor(
    readonly cwd: string,
    readonly strict: boolean,
    /** The owning session or analysis must abort this on disposal. */
    readonly signal: AbortSignal,
    private readonly override?: (cwd: string, manager: 'npm' | 'pnpm') => PackageManagerInvocation | null | Promise<PackageManagerInvocation | null>
  ) {}

  npm(): Promise<NpmResolutionResult> {
    throwIfAborted(this.signal);
    return this.npmLookup ??= resolveNpmInvocationAsync(createNodeNpmResolverAsyncDeps(this.cwd, this.signal, this.strict));
  }

  resolve(manager: 'npm' | 'pnpm'): Promise<PackageManagerInvocation | null> {
    throwIfAborted(this.signal);
    let pending = this.invocations.get(manager);
    if (pending === undefined) {
      // Store before starting work so concurrent consumers share even an in-flight probe.
      pending = Promise.resolve().then(async () => {
        throwIfAborted(this.signal);
        const npm = this.override === undefined ? await this.npm() : undefined;
        const invocation = this.override !== undefined ? await this.override(this.cwd, manager)
          : manager === 'pnpm' ? await resolveInstalledPnpmInvocationAsync(npm?.ok ? npm.invocation : null, this.cwd, this.strict, this.signal)
          : npm?.ok ? { executable: npm.invocation.node, prefixArgs: [npm.invocation.npmCliJs], version: npm.invocation.version } : null;
        throwIfAborted(this.signal);
        return invocation;
      });
      this.invocations.set(manager, pending);
    }
    return pending;
  }
}
