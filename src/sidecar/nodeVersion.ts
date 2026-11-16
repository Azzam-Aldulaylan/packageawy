/**
 * The Node.js versions the sidecar runs on. A bundled runtime package (ini)
 * declares `^18.17.0 || >=20.5.0`, and the JetBrains plugin lets the user
 * pick any interpreter, so the floor is checked when the sidecar starts.
 * The JetBrains plugin checks the same range before launching, so the IDE
 * can show the message (NodeVersion.kt).
 */

export const NODE_REQUIREMENT =
  'Packageawy requires a stable Node.js release: 18.17.x through 18.x, or 20.5.0 or newer.';

/** Only a full stable vX.Y.Z. A prerelease or nightly is outside the declared range. */
const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function supported(version: string): boolean {
  const match = STABLE_VERSION.exec(version);
  if (match === null) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return (major === 18 && minor >= 17) || (major === 20 && minor >= 5) || major > 20;
}

/**
 * The message to show, or null when `version` is supported. The sidecar is
 * the last check, so a version it cannot read is refused too.
 */
export function unsupportedNodeMessage(version: string): string | null {
  return supported(version) ? null : `${NODE_REQUIREMENT} Found ${version}.`;
}
