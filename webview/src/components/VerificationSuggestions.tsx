import { createContext, useContext } from 'react';
import type { ReactElement } from 'react';

import type { ConfirmVerificationOptIn, UpgradeAnalysisVerification } from '../../../src/host/webviewProtocol.js';

/**
 * The user's one-run choice among host-suggested verification scripts for
 * one analysis. The host revalidates every name at confirm time. This is
 * only a request.
 */
export interface VerificationOptInSelection {
  scripts: readonly string[];
  remember: boolean;
}

export const EMPTY_VERIFICATION_OPT_IN: VerificationOptInSelection = { scripts: [], remember: false };

export interface VerificationOptInStore {
  selectionFor(analysisId: string): VerificationOptInSelection;
  update(analysisId: string, selection: VerificationOptInSelection): void;
}

const NO_STORE: VerificationOptInStore = {
  selectionFor: () => EMPTY_VERIFICATION_OPT_IN,
  update: () => undefined,
};

/** Provided by App, keyed by host-issued analysis id. */
export const VerificationOptInContext = createContext<VerificationOptInStore>(NO_STORE);

/** Selected suggestions in the host's order. Empty when the analysis has its own configured scripts. */
export function selectedSuggestions(
  verification: UpgradeAnalysisVerification,
  selection: VerificationOptInSelection
): string[] {
  if (verification.configured) return [];
  return verification.suggestedScriptNames.filter((name) => selection.scripts.includes(name));
}

/** The optional confirm-message fields for this selection. */
export function confirmVerificationFields(
  verification: UpgradeAnalysisVerification,
  selection: VerificationOptInSelection
): ConfirmVerificationOptIn {
  const scripts = selectedSuggestions(verification, selection);
  if (scripts.length === 0) return {};
  return selection.remember
    ? { verificationScripts: scripts, rememberVerificationScripts: true }
    : { verificationScripts: scripts };
}

export function useVerificationOptIn(
  analysisId: string | undefined,
  verification: UpgradeAnalysisVerification
): { selected: string[]; selection: VerificationOptInSelection } {
  const store = useContext(VerificationOptInContext);
  const selection = analysisId === undefined ? EMPTY_VERIFICATION_OPT_IN : store.selectionFor(analysisId);
  return { selected: selectedSuggestions(verification, selection), selection };
}

/** Selected suggestions as queued steps in a "Verification steps" preview. */
export function QueuedScriptSteps({ names }: { names: readonly string[] }): ReactElement {
  return (
    <>
      {names.map((name) => (
        <li className="verification-steps__item" key={name}>
          <span>
            Run <code>{name}</code>
          </span>
          <span className="status-badge status-badge--neutral">Queued</span>
        </li>
      ))}
    </>
  );
}

/**
 * Unchecked checkboxes for each detected script, plus "Remember for this
 * project". Renders nothing until the analysis has an id, or when nothing
 * was detected.
 */
export function VerificationSuggestions({
  analysisId,
  verification,
  actionLabel,
}: {
  analysisId: string | undefined;
  verification: UpgradeAnalysisVerification;
  /** For example "this upgrade" or "this removal". */
  actionLabel: string;
}): ReactElement | null {
  const store = useContext(VerificationOptInContext);
  if (analysisId === undefined || verification.configured || verification.suggestedScriptNames.length === 0) return null;
  const selection = store.selectionFor(analysisId);
  const selected = selectedSuggestions(verification, selection);
  const toggle = (name: string, checked: boolean): void => {
    const scripts = checked
      ? [...selection.scripts.filter((entry) => entry !== name), name]
      : selection.scripts.filter((entry) => entry !== name);
    store.update(analysisId, { scripts, remember: selection.remember });
  };
  return (
    <fieldset className="verification-suggestions">
      <legend className="verification-suggestions__legend">Detected scripts. Run after {actionLabel}:</legend>
      {verification.suggestedScriptNames.map((name) => (
        <label className="verification-suggestions__option" key={name}>
          <input
            className="review-list__checkbox"
            type="checkbox"
            checked={selected.includes(name)}
            onChange={(event) => toggle(name, event.currentTarget.checked)}
          />
          <span>
            Run <code>{name}</code>
          </span>
        </label>
      ))}
      <label className="verification-suggestions__option verification-suggestions__remember">
        <input
          className="review-list__checkbox"
          type="checkbox"
          checked={selection.remember}
          disabled={selected.length === 0}
          onChange={(event) => store.update(analysisId, { scripts: selection.scripts, remember: event.currentTarget.checked })}
        />
        <span>Remember for this project</span>
      </label>
    </fieldset>
  );
}
