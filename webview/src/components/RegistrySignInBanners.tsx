import type { ReactElement } from 'react';

import type { RegistrySignInGroup } from '../../../src/core/types.js';
import { registrySignInBannerText } from '../../../src/host/registrySignIn.js';
import { StatusBanner } from './StatusBanner.js';

/** One info banner per registry host that asked for sign-in. */
export function RegistrySignInBanners({ groups }: { groups: readonly RegistrySignInGroup[] | undefined }): ReactElement | null {
  if (groups === undefined || groups.length === 0) return null;
  return (
    <>
      {groups.map((group) => (
        <StatusBanner key={group.registryHost} tone="info">
          {registrySignInBannerText(group)}
        </StatusBanner>
      ))}
    </>
  );
}
