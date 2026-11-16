import type { WebviewToHostMessage } from '../../src/host/webviewProtocol.js';

interface AnimationFrames {
  request(callback: () => void): number;
  cancel(id: number): void;
}

/** One tracker per webview load. Cleanup belongs to the committed snapshot's effect. */
export function createSnapshotRenderTracker(
  enabled: boolean,
  postMessage: (message: Extract<WebviewToHostMessage, { type: 'rendered' }>) => void,
  frames: AnimationFrames = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  }
): (generatedAt: string, onPaint?: () => void) => (() => void) | undefined {
  const acknowledged = new Set<string>();
  return (generatedAt, onPaint) => {
    const acknowledge = enabled && !acknowledged.has(generatedAt);
    if (!acknowledge && onPaint === undefined) return;
    let secondFrame: number | undefined;
    const firstFrame = frames.request(() => {
      secondFrame = frames.request(() => {
        // A single animation callback runs before paint. Wait for the next frame.
        if (acknowledge && !acknowledged.has(generatedAt)) {
          acknowledged.add(generatedAt);
          postMessage({ type: 'rendered', generatedAt });
        }
        onPaint?.();
      });
    });
    return () => {
      frames.cancel(firstFrame);
      if (secondFrame !== undefined) frames.cancel(secondFrame);
    };
  };
}
