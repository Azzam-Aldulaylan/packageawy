import { useContext } from 'react';
import type { ReactElement } from 'react';

import type { UpgradeReason } from '../../../src/core/types.js';
import type { ProtocolError, UpgradeTargetOptions } from '../../../src/host/webviewProtocol.js';
import { updateAdvisoryTag, updateAdvisoryWarning } from '../../../src/host/updateAdvisoryState.js';
import { UpdateAdvisoryContext, UpdateVersionWarning } from './UpdateVersionWarning.js';

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
  registryName,
  selectedVersion,
  fallbackVersion,
  fallbackReason,
  disabled,
  onChange,
}: {
  state: UpgradeTargetLoadState;
  registryName?: string;
  selectedVersion: string | null;
  fallbackVersion: string | null;
  fallbackReason?: UpgradeReason | null;
  disabled: boolean;
  onChange: (version: string) => void;
}): ReactElement {
  const results = useContext(UpdateAdvisoryContext);
  const resultFor = (version: string) => results.find(result => result.name === registryName && result.version === version);
  /**
   * A native select shows plain text only, so a vulnerable option gets a short
   * tag after its label ("2.3.0 · Latest stable · 3 vulnerabilities (high)")
   * and the full sentence as its title where the platform shows one. The
   * selected version's full warning is the triangle beside the list.
   */
  const versionOption = (version: string, label: string): ReactElement => {
    const result = resultFor(version);
    const tag = updateAdvisoryTag(result);
    return (
      <option value={version} key={version} title={updateAdvisoryWarning(result)}>
        {tag === undefined ? label : `${label} · ${tag}`}
      </option>
    );
  };
  const ready = state.phase === 'ready' ? state.targets : null;
  const stable = ready?.options.filter((option) => option.channel === 'stable') ?? [];
  const prerelease = ready?.options.filter((option) => option.channel === 'prerelease') ?? [];
  const usableFallback = state.phase === 'error' || state.phase === 'idle' ? fallbackVersion : null;
  const value = selectedVersion ?? fallbackVersion ?? ready?.recommendedVersion ?? '';
  const selectedIsOutsideCurrentOptions = value !== '' && ready !== null && !ready.options.some((option) => option.version === value);
  const selectedWarning = registryName !== undefined && value !== '' && state.phase !== 'loading'
    ? updateAdvisoryWarning(resultFor(value)) : undefined;
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
        <div className="upgrade-target-picker__row">
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
            aria-describedby={selectedWarning === undefined ? undefined : 'upgrade-target-version-warning'}
          >
            {state.phase === 'loading' ? <option value={value}>Loading published versions…</option> : null}
            {ready !== null ? (
              <>
                {selectedIsOutsideCurrentOptions ? versionOption(value, `${value} (${value === fallbackVersion ? fallbackLabel : 'selected target'})`) : null}
                {ready.recommendedVersion === null ? <option value="">Select a version…</option> : null}
                {stable.length > 0 ? (
                  <optgroup label="Stable releases">
                    {stable.map((option) => versionOption(option.version, optionLabel(option)))}
                  </optgroup>
                ) : null}
                {prerelease.length > 0 ? (
                  <optgroup label="Prereleases (review carefully)">
                    {prerelease.map((option) => versionOption(option.version, optionLabel(option)))}
                  </optgroup>
                ) : null}
              </>
            ) : null}
            {usableFallback !== null ? versionOption(usableFallback, `${usableFallback} (${fallbackLabel})`) : null}
          </select>
          {selectedWarning !== undefined && registryName !== undefined ? (
            <UpdateVersionWarning name={registryName} version={value} />
          ) : null}
        </div>
        {selectedWarning === undefined ? null : (
          <span className="sr-only" id="upgrade-target-version-warning">{selectedWarning}</span>
        )}
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
