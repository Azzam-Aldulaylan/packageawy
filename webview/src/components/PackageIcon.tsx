import type { ReactElement } from 'react';

import { IconPackage } from '../icons.js';

/**
 * `name` is accepted (and currently ignored) so a future package-specific
 * icon provider. See the redesign spec's "Dependency Package Icons"
 * section: can key off it without every call site changing shape. This
 * phase renders only the generic package glyph. No per-package mapping and
 * no network lookup.
 */
export function PackageIcon(_props: { name: string }): ReactElement {
  return (
    <span className="package-icon" aria-hidden="true">
      <IconPackage />
    </span>
  );
}
