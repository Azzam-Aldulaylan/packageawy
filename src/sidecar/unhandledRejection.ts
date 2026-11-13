/**
 * The sidecar's last resort for a promise rejection nothing handled.
 *
 * Without a handler Node ends the process, which would cut off a change that
 * is still installing. Instead this logs a safe line, pauses changes in the
 * open panel (which also stops its background work and shows the banner),
 * and asks the IDE to show one notification.
 *
 * It never exits, releases the project lock or rolls anything back. A change
 * that already started keeps running and releases normally: the panel only
 * refuses changes that have not started yet. A disconnect still ends the
 * process as before (see main.ts).
 *
 * Only `unhandledRejection` is handled. After `uncaughtException` Node's own
 * documentation says the process is in an undefined state, so it is left to
 * Node's default.
 */

import { RUNTIME_ERROR_TEXT, RUNTIME_ERROR_WITHOUT_PANEL_TEXT, runtimeFailureLine } from '../core/diagnostics.js';

export interface UnhandledRejectionDeps {
  /** Writes one line to the IDE log (stderr). */
  log(line: string): void;
  /** Pauses changes in the open panel. False when no panel is open. */
  reportToPanel(reason: unknown): boolean;
  /** Shows an IDE notification through window/showMessage. */
  notify(message: string): void;
}

export function createUnhandledRejectionHandler(deps: UnhandledRejectionDeps): (reason: unknown) => void {
  let notified = false;
  return (reason) => {
    // Each step is guarded on its own: a failure in one must not skip the rest,
    // and a throw from here would only come back as another rejection.
    let paused = false;
    try {
      // The panel writes the same safe line to the log itself.
      paused = deps.reportToPanel(reason);
    } catch {
      // The panel could not take the failure. The line below and the notification still say so.
    }
    if (!paused) {
      try {
        deps.log(runtimeFailureLine('unhandled-rejection', reason));
      } catch {
        // Nothing to log to.
      }
    }
    // Once per process: a burst of rejections should not stack notifications.
    if (notified) return;
    notified = true;
    try {
      // With no panel open there is nothing to pause: the next panel starts clean.
      deps.notify(paused ? RUNTIME_ERROR_TEXT : RUNTIME_ERROR_WITHOUT_PANEL_TEXT);
    } catch {
      // The client is gone. Its disconnect ends the process.
    }
  };
}
