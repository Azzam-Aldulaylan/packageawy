import type { OtherPackageManager } from '../core/manifest/parse.js';
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

/** The host-side refusal for every dependency change, or null when npm or pnpm owns the project. */
export function dependencyChangeRefusal(
  source: { otherPackageManager?: OtherPackageManager | null | undefined } | undefined
): ProtocolError | null {
  const kind = source?.otherPackageManager ?? null;
  if (kind === null) return null;
  return { code: 'PACKAGE_MANAGER_READ_ONLY', message: otherPackageManagerMessage(kind) };
}
