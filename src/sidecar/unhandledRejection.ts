/** Last resort process failures fence every prepared change, including closed panels. */

import { fireAndForget } from '../core/fireAndForget.js';
import { projectMutationLocks } from '../host/projectMutationLock.js';
import { settleProcessFailure } from '../host/operationReservation.js';
import { RECOVERY_MESSAGES } from '../host/recoveryCopy.js';
import { runtimeFailureLine } from '../core/diagnostics.js';

export interface UnhandledRejectionDeps {
  /** Writes one line to the IDE log (stderr). */
  log(line: string): void;
  /** Pauses changes in the open panel. False when no panel is open. */
  reportToPanel(reason: unknown): boolean;
  /** Shows an IDE notification through window/showMessage. */
  notify(message: string): void;
}

export function createUnhandledRejectionHandler(deps: UnhandledRejectionDeps, context: 'unhandled-rejection' | 'uncaught-exception' = 'unhandled-rejection'): (reason: unknown) => void {
  let notified = false;
  return (reason) => {
    // Unattributed process errors cannot be proved unrelated to an active writer.
    projectMutationLocks.closeAfterFailure();
    const settlement = settleProcessFailure(projectMutationLocks, 'An internal error interrupted the dependency change.');
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
        deps.log(runtimeFailureLine(context, reason));
      } catch {
        // Nothing to log to.
      }
    }
    // Once per process: a burst of rejections should not stack notifications.
    if (notified) { fireAndForget(settlement, () => undefined); return; }
    notified = true;
    fireAndForget(settlement.then(() => {
      deps.notify(RECOVERY_MESSAGES.restartRequired);
    }), () => undefined);
  };
}
