import type { ReactElement } from 'react';

import type { HygieneFilterId } from '../../../src/host/hygieneFilter.js';

/**
 * Same segmented-button pattern as DependencyTypeFilter: the two toolbar
 * filters read as one consistent control language rather than a button
 * group next to an unrelated-looking dropdown.
 */
export function HygieneFilter({
  value,
  likelyUnusedCount,
  onChange,
}: {
  value: HygieneFilterId;
  /** `checking` while the usage scan runs, `null` before any scan finished, so a count is never shown before it is known. */
  likelyUnusedCount: number | 'checking' | null;
  onChange: (value: HygieneFilterId) => void;
}): ReactElement {
  const options: readonly { id: HygieneFilterId; label: string }[] = [
    { id: 'all', label: 'All' },
    {
      id: 'likely-unused',
      label: likelyUnusedCount === null
        ? 'Likely unused'
        : likelyUnusedCount === 'checking'
          ? 'Likely unused (checking…)'
          : `Likely unused (${likelyUnusedCount})`,
    },
  ];
  return (
    <div className="type-filter" role="radiogroup" aria-label="Filter by dependency finding">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className="type-filter__option"
          data-selected={value === option.id ? 'true' : undefined}
          onClick={() => {
            onChange(option.id);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
