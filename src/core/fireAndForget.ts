/**
 * Starts work nobody waits for, and names who hears about its failure.
 *
 * A bare `void promise` hides a rejection: Node reports it as unhandled (the
 * sidecar would treat that as an internal error) and the extension host drops
 * it. Every deliberate background call goes through here instead, so its
 * failure reaches a handler that logs it.
 *
 * The handler itself must never be able to reject. A throw from it, or a
 * rejection of a thenable it returns by mistake, is caught here and written
 * with console.error as a last resort. That write is guarded too, so this
 * function can never produce an unhandled rejection of its own.
 *
 * Nothing here may import 'vscode' or host modules. See types.ts.
 */
export function fireAndForget(work: PromiseLike<unknown>, onError: (error: unknown) => undefined): void {
  // Promise.resolve adopts a bare thenable (VS Code's Thenable) so `.then`
  // with a rejection handler always exists.
  Promise.resolve(work).then(undefined, (error: unknown) => {
    reportSafely(onError, error);
  });
}

function reportSafely(onError: (error: unknown) => undefined, error: unknown): void {
  let returned: unknown;
  try {
    returned = onError(error);
  } catch (handlerError) {
    lastResort(handlerError);
    return;
  }
  // The type says undefined, but a handler written as `async` still compiles
  // where a cast slipped in. Promise.resolve adopts whatever came back without
  // this code reading `.then` itself: a throwing `then` getter becomes a
  // rejection here, observed like any other.
  if (returned === undefined) return;
  try {
    Promise.resolve(returned).then(undefined, (handlerError: unknown) => {
      lastResort(handlerError);
    });
  } catch (adoptError) {
    lastResort(adoptError);
  }
}

function lastResort(error: unknown): void {
  try {
    // Never the message or a custom name: either can carry paths or URLs.
    const kind = error instanceof Error ? 'error' : typeof error;
    console.error(`Packageawy: a failure handler failed (${kind})`);
  } catch {
    // Nothing is left to report to.
  }
}
