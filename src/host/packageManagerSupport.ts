import type { OtherPackageManager } from '../core/manifest/parse.js';
import { UNRESOLVED_MUTATION_TARGET } from './mutationTarget.js';
import type { MutationTarget, MutationTargetResolution } from './mutationTarget.js';
import type { ProtocolError } from './webviewProtocol.js';

const PACKAGE_MANAGER_NAMES: Record<Exclude<OtherPackageManager, 'unknown'>, string> = {
  yarn: 'Yarn',
  bun: 'Bun',
};

/**
 * Why dependency changes are off for a project another package manager owns.
 * Running npm or pnpm there would write a second lockfile next to the real one.
 */
export function otherPackageManagerMessage(kind: OtherPackageManager): string {
  const subject = kind === 'unknown'
    ? 'This project names a different package manager in package.json.'
    : `This project uses ${PACKAGE_MANAGER_NAMES[kind]}.`;
  return `${subject} Packageawy shows its dependencies, and changes are available for npm and pnpm projects.`;
}

/** Code every expected mutation-target refusal is posted with, so none of them reads as an internal error. */
export const MUTATION_TARGET_REFUSED_CODE = 'CHANGES_UNAVAILABLE';

interface ChangeSource {
  otherPackageManager?: OtherPackageManager | null | undefined;
  mutationTarget?: MutationTargetResolution | null | undefined;
}

/**
 * The host-side refusal for every dependency change, or null when npm or
 * pnpm owns the project and the place it writes is known. A source without a
 * resolved target is refused: no consumer may guess the lockfile.
 */
export function dependencyChangeRefusal(source: ChangeSource | undefined): ProtocolError | null {
  const kind = source?.otherPackageManager ?? null;
  if (kind !== null) return { code: 'PACKAGE_MANAGER_READ_ONLY', message: otherPackageManagerMessage(kind) };
  const resolution = source?.mutationTarget ?? UNRESOLVED_MUTATION_TARGET;
  if (resolution.ok) return null;
  return { code: MUTATION_TARGET_REFUSED_CODE, message: resolution.refusal.reason };
}

/** The target a change writes, or the refusal to post instead. */
export function requireMutationTarget(
  source: ChangeSource | undefined
): { ok: true; target: MutationTarget } | { ok: false; error: ProtocolError } {
  const refusal = dependencyChangeRefusal(source);
  if (refusal !== null) return { ok: false, error: refusal };
  const resolution = source?.mutationTarget ?? UNRESOLVED_MUTATION_TARGET;
  return resolution.ok ? { ok: true, target: resolution.target } : { ok: false, error: { code: MUTATION_TARGET_REFUSED_CODE, message: resolution.refusal.reason } };
}

/** Why dependency changes are off, for the dashboard banner. Only an explicit refusal is shown. */
export function readOnlyReasonFor(source: ChangeSource): string | undefined {
  const kind = source.otherPackageManager ?? null;
  if (kind !== null) return otherPackageManagerMessage(kind);
  const resolution = source.mutationTarget;
  return resolution === null || resolution === undefined || resolution.ok ? undefined : resolution.refusal.reason;
}
