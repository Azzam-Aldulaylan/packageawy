import { createContext, useContext } from 'react';
import type { UpdateAdvisoryResult } from '../../../src/host/webviewProtocol.js';
import { isInstalledVersion, updateAdvisoryWarning } from '../../../src/host/updateAdvisoryState.js';
import { IconAlertTriangle } from '../icons.js';
import { InfoTooltip } from './Tooltip.js';

export const UpdateAdvisoryContext = createContext<readonly UpdateAdvisoryResult[]>([]);

export function useUpdateVersionWarning(name: string, version: string | null): string | undefined {
  const results = useContext(UpdateAdvisoryContext);
  return updateAdvisoryWarning(results.find(result => result.name === name && result.version === version));
}

/**
 * Warning triangle for a version the user may upgrade to. `current` is the
 * row's installed version: results are shared by registry name and version
 * across alias rows, so this per-row guard keeps the installed version
 * unmarked (its findings are in the Vulnerabilities column).
 */
export function UpdateVersionWarning({ name, version, current }: {
  name: string; version: string | null; current?: string | null;
}) {
  const warning = useUpdateVersionWarning(name, version);
  if (warning === undefined || isInstalledVersion(current, version)) return null;
  return <InfoTooltip className="update-version-warning" label={warning} content={<p>{warning}</p>}
    icon={<IconAlertTriangle />} />;
}
