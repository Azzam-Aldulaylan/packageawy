/**
 * Copy and lookups for registries that ask for sign-in.
 *
 * Packageawy never sends registry credentials, so a private registry that
 * requires them answers 401/403 and its packages have no update information.
 * Lives under src/host (not webview/src) so it compiles to out/ for tests.
 */

import type { RegistrySignInGroup, ScanDataAvailability } from '../core/types.js';

export const SIGN_IN_CELL_LABEL = 'Sign-in needed';

export function registrySignInBannerText(group: RegistrySignInGroup): string {
  const count = group.packages.length;
  return `${group.registryHost} asks for sign-in, so update information for ${count} package${count === 1 ? '' : 's'} is not shown. Packageawy does not send registry sign-in details.`;
}

export function registrySignInCellTitle(registryHost: string): string {
  return `${registryHost} asks for sign-in. Packageawy does not send registry sign-in details.`;
}

/** Package name to the registry host that asked for sign-in. */
export function signInHostsByPackage(availability: ScanDataAvailability): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const group of availability.signInRequired ?? []) {
    for (const name of group.packages) hosts.set(name, group.registryHost);
  }
  return hosts;
}

/**
 * Update information counts as complete when every package without it is on
 * a registry that asked for sign-in. Those packages have no upgrade target,
 * so they never block upgrades for the rest of the project.
 */
export function updatesSettled(availability: ScanDataAvailability): boolean {
  if (availability.updates === 'complete') return true;
  const signIn = signInHostsByPackage(availability);
  return availability.unavailableUpdatePackages.every((name) => signIn.has(name));
}
