/**
 * Shared Tab/Shift+Tab trap for the webview's modal dialogs.
 *
 * Each dialog keeps its own Escape handling, initial focus and focus
 * restoration. This module only decides where Tab goes. The decision is made
 * at keydown time from the controls that are tabbable right then, so steps
 * and phases that swap the dialog's content need no extra wiring.
 */

const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where focus should go for one Tab press, or null to let the browser move it.
 *
 * Wraps from the last control to the first (and back with Shift). When focus
 * is not on one of the tabbable controls (the dialog itself, a heading
 * focused programmatically with tabIndex -1, plain content, or somewhere
 * outside the dialog), Tab goes to the first control and Shift+Tab to the
 * last, so focus can never step out of the dialog.
 */
export function nextFocusTarget<T>(
  tabbables: readonly T[],
  active: T | null,
  activeInside: boolean,
  backwards: boolean
): T | null {
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  if (first === undefined || last === undefined) return null;
  const index = activeInside && active !== null ? tabbables.indexOf(active) : -1;
  if (index === -1) return backwards ? last : first;
  if (backwards && index === 0) return last;
  if (!backwards && index === tabbables.length - 1) return first;
  return null;
}

function tabbableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && element.offsetParent !== null
  );
}

/** Open traps in mount order; only the most recently opened dialog traps Tab. */
const openTraps: HTMLElement[] = [];

/** True when `container` is the most recently opened dialog, the one keyboard shortcuts belong to. */
export function isTopmostTrap(container: HTMLElement): boolean {
  return openTraps[openTraps.length - 1] === container;
}

/**
 * Traps Tab inside `container` until the returned cleanup runs. Listens on the
 * document so focus that has left the dialog is pulled back in as well.
 */
export function trapFocus(container: HTMLElement): () => void {
  openTraps.push(container);
  const ownerDocument = container.ownerDocument;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    if (openTraps[openTraps.length - 1] !== container) return;
    const active = ownerDocument.activeElement instanceof HTMLElement ? ownerDocument.activeElement : null;
    const tabbables = tabbableElements(container);
    if (tabbables.length === 0) {
      event.preventDefault();
      return;
    }
    const target = nextFocusTarget(tabbables, active, active !== null && container.contains(active), event.shiftKey);
    if (target === null) return;
    event.preventDefault();
    target.focus();
  };
  ownerDocument.addEventListener('keydown', onKeyDown);
  return () => {
    ownerDocument.removeEventListener('keydown', onKeyDown);
    const index = openTraps.lastIndexOf(container);
    if (index !== -1) openTraps.splice(index, 1);
  };
}
