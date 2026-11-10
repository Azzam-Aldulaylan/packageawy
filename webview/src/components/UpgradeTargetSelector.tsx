import type { ReactElement } from 'react';

import type { UpgradeReason } from '../../../src/core/types.js';
import type { ProtocolError, UpgradeTargetOptions } from '../../../src/host/webviewProtocol.js';

export type UpgradeTargetLoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; targets: UpgradeTargetOptions }
  | { phase: 'error'; error: ProtocolError }
  | { phase: 'idle' };

function optionLabel(
  option: UpgradeTargetOptions['options'][number]
): string {
  const labels = option.labels.map((label) => {
    if (label === 'recommended') return 'Recommended';
    if (label === 'lts') return 'Publisher LTS';
    if (label === 'security-fix') return 'Security fix';
    return 'Latest stable';
  });
  return labels.length === 0 ? option.version : `${option.version} · ${labels.join(' · ')}`;
}

export function UpgradeTargetSelector({
  state,
  selectedVersion,
  fallbackVersion,
  fallbackReason,
  disabled,
  onChange,
}: {
  state: UpgradeTargetLoadState;
  selectedVersion: string | null;
  fallbackVersion: string | null;
  fallbackReason?: UpgradeReason | null;
  disabled: boolean;
  onChange: (version: string) => void;
}): ReactElement {
  const ready = state.phase === 'ready' ? state.targets : null;
  const stable = ready?.options.filter((option) => option.channel === 'stable') ?? [];
  const prerelease = ready?.options.filter((option) => option.channel === 'prerelease') ?? [];
  const usableFallback = state.phase === 'error' || state.phase === 'idle' ? fallbackVersion : null;
  const value = selectedVersion ?? fallbackVersion ?? ready?.recommendedVersion ?? '';
  const selectedIsOutsideCurrentOptions = value !== '' && ready !== null && !ready.options.some((option) => option.version === value);
  const fallbackLabel = fallbackReason === 'security-fix' ? 'Security fix' : 'dashboard target';

  return (
    <section className="upgrade-target-picker" aria-labelledby="upgrade-target-picker-label">
      <div className="upgrade-target-picker__copy">
        <label className="upgrade-target-picker__label" id="upgrade-target-picker-label" htmlFor="upgrade-target-version">
          Upgrade to
        </label>
        <p className="upgrade-target-picker__hint">
          Starts on the version shown on the dashboard. Security fix, Publisher LTS and Latest stable versions
          are labelled in the list.
        </p>
      </div>
      <div className="upgrade-target-picker__control">
        <select
          className="upgrade-target-picker__select"
          id="upgrade-target-version"
          value={value}
          disabled={
            disabled ||
            state.phase === 'loading' ||
            (state.phase === 'ready' ? state.targets.options.length === 0 : value === '')
          }
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {state.phase === 'loading' ? <option value={value}>Loading published versions…</option> : null}
          {ready !== null ? (
            <>
              {selectedIsOutsideCurrentOptions ? <option value={value}>{value} ({value === fallbackVersion ? fallbackLabel : 'selected target'})</option> : null}
              {ready.recommendedVersion === null ? <option value="">Select a version…</option> : null}
              {stable.length > 0 ? (
                <optgroup label="Stable releases">
                  {stable.map((option) => (
                    <option value={option.version} key={option.version}>
                      {optionLabel(option)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {prerelease.length > 0 ? (
                <optgroup label="Prereleases (review carefully)">
                  {prerelease.map((option) => (
                    <option value={option.version} key={option.version}>
                      {optionLabel(option)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </>
          ) : null}
          {usableFallback !== null ? (
            <option value={usableFallback}>{usableFallback} ({fallbackLabel})</option>
          ) : null}
        </select>
        {ready?.truncated === true ? (
          <span className="upgrade-target-picker__meta">Showing recent and tagged releases.</span>
        ) : null}
        {state.phase === 'error' ? (
          <span className="upgrade-target-picker__meta upgrade-target-picker__meta--warning" role="status">
            Published versions could not be loaded. The existing dashboard target remains available.
          </span>
        ) : null}
      </div>
    </section>
  );
}
