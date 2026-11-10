import { createContext, useContext } from 'react';
import type { UpdateAdvisoryResult } from '../../../src/host/webviewProtocol.js';
import { updateAdvisoryWarning } from '../../../src/host/updateAdvisoryState.js';
import { IconAlertTriangle } from '../icons.js';
import { InfoTooltip } from './Tooltip.js';

export const UpdateAdvisoryContext = createContext<readonly UpdateAdvisoryResult[]>([]);

export function useUpdateVersionWarning(name: string, version: string | null): string | undefined {
  const results = useContext(UpdateAdvisoryContext);
  return updateAdvisoryWarning(results.find(result => result.name === name && result.version === version));
}

export function UpdateVersionWarning({ name, version }: { name: string; version: string | null }) {
  const warning = useUpdateVersionWarning(name, version);
  if (warning === undefined) return null;
  return <InfoTooltip className="update-version-warning" label={warning} content={<p>{warning}</p>}
    icon={<IconAlertTriangle />} />;
}
