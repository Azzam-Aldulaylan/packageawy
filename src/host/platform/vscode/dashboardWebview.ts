/**
 * The VS Code webview panel that hosts the dashboard: HTML, CSP, and the
 * WebviewChannel DashboardPanel talks through.
 *
 * SECURITY: the three rules enforced here:
 *   1. A fresh cryptographically-random nonce per HTML load, and no
 *      `unsafe-inline`/`unsafe-eval` anywhere in the policy. `default-src
 *      'none'` means anything not explicitly allowed below is blocked,
 *      including every network destination: the webview cannot phone home.
 *   2. `localResourceRoots` is exactly `dist/`, so nothing else in the
 *      extension directory or the user's workspace is loadable.
 *   3. No inline <script>. The only script is the nonce-tagged bundle.
 * DashboardPanel validates every inbound message.
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { DashboardPanel } from '../../dashboardPanel.js';
import { OPEN_MANIFEST_UNAVAILABLE_MESSAGE, resolveManifestTarget } from '../../openManifestTarget.js';
import type { HostPlatform, WebviewChannel } from '../hostPlatform.js';
import { runtimeFailureLine } from '../../../core/diagnostics.js';
import { fireAndForget } from '../../../core/fireAndForget.js';

const VIEW_TYPE = 'packageawy';
const TITLE = 'Packageawy';
/** Coalesces the burst of events a rebuild writes. */
const DEV_RELOAD_DEBOUNCE_MS = 300;

/**
 * `cacheBust` is appended as a query string on both asset URLs so that
 * re-assigning `panel.webview.html` (the dev-mode auto-reload watcher below)
 * is guaranteed to fetch the just-rebuilt `webview.js`/`webview.css` bytes
 * rather than whatever Chromium's resource cache already has for that exact
 * URL: the nonce changes the inline `<script>` tag itself, but does nothing
 * about the cached response behind an unchanged `src`. Callers pass
 * `Date.now()`. This is purely a cache key. The real timestamp shown in the
 * UI is `buildInfo.builtAt` (`__BUILD_TIME__`, fixed for this extension host
 * process's whole lifetime. See that field's doc).
 */
function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, performanceEnabled: boolean, renderAcknowledgements: boolean, cacheBust: number): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri.toString()}?v=${cacheBust}" />
    <title>${TITLE}</title>
  </head>
  <body data-performance-debug="${performanceEnabled ? 'true' : 'false'}" data-render-acknowledgements="${renderAcknowledgements ? 'true' : 'false'}">
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}?v=${cacheBust}"></script>
  </body>
</html>`;
}

function createChannel(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, platform: HostPlatform): WebviewChannel {
  return {
    postMessage: (message) => {
      // Straight to the log, never back through the webview: reporting a
      // broken channel over that same channel would only fail again.
      fireAndForget(panel.webview.postMessage(message), (error) => {
        platform.log?.(runtimeFailureLine('webview-delivery', error));
      });
    },
    onDidReceiveMessage: (listener) => panel.webview.onDidReceiveMessage(listener, null, context.subscriptions),
    onDidDispose: (listener) => panel.onDidDispose(listener, null, context.subscriptions),
    reveal: () => panel.reveal(vscode.ViewColumn.One),
  };
}

/**
 * Dev-mode-only ("F5" Extension Development Host) auto-reload: watches this
 * extension's `dist/webview.{js,css}` and re-assigns `panel.webview.html`
 * shortly after `npm run watch` finishes a rebuild, so the panel picks up
 * UI changes without a manual "close tab and reopen" or a full window
 * reload. Never created for a real installed extension: `extensionMode`
 * is `Development` only under `--extensionDevelopmentPath`. This is a full
 * webview reload, not state-preserving React Fast Refresh: the in-progress
 * scan/manage-modal state resets, same as any other panel re-creation.
 */
function watchDevBuild(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  performanceEnabled: () => boolean,
  integrationTestMode: boolean
): void {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.joinPath(context.extensionUri, 'dist'), 'webview.{js,css}')
  );
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  const scheduleReload = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      const performanceDebug = performanceEnabled();
      panel.webview.html = buildHtml(panel.webview, context.extensionUri, performanceDebug, performanceDebug || integrationTestMode, Date.now());
    }, DEV_RELOAD_DEBOUNCE_MS);
  };
  watcher.onDidChange(scheduleReload);
  watcher.onDidCreate(scheduleReload);
  panel.onDidDispose(
    () => {
      disposed = true;
      watcher.dispose();
      if (timer !== undefined) clearTimeout(timer);
    },
    null,
    context.subscriptions
  );
}

/**
 * "Open in Packageawy" on a package.json. An open dashboard switches to that
 * project. Otherwise the file is checked first, so a file that is not a
 * workspace project shows a message instead of opening an empty panel.
 */
export async function openManifestInDashboard(
  context: vscode.ExtensionContext,
  platform: HostPlatform,
  manifestPath: string
): Promise<void> {
  if (DashboardPanel.openManifest(manifestPath)) return;
  let project;
  try {
    ({ project } = await resolveManifestTarget(platform, manifestPath));
  } catch {
    // Discovery failed: the panel runs it again and shows the error itself.
    showDashboard(context, platform, manifestPath);
    return;
  }
  if (project === undefined) {
    platform.showInformationMessage(OPEN_MANIFEST_UNAVAILABLE_MESSAGE);
    return;
  }
  // Opened while discovery ran: hand the request to that panel instead.
  if (DashboardPanel.openManifest(manifestPath)) return;
  showDashboard(context, platform, manifestPath);
}

/** Reveals the open dashboard, or creates it. */
export function showDashboard(context: vscode.ExtensionContext, platform: HostPlatform, initialManifestPath?: string): void {
  if (DashboardPanel.reveal()) return;

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')], // Rule 2.
    retainContextWhenHidden: true,
  });
  const createdAt = Date.now();
  const integrationTestMode = context.extensionMode === vscode.ExtensionMode.Test ||
    process.env['PACKAGEAWY_EXTENSION_TEST'] === '1';
  const performanceEnabled = (): boolean => platform.getSetting<boolean>('debug.performance', false);
  const performanceDebug = performanceEnabled();
  panel.webview.html = buildHtml(panel.webview, context.extensionUri, performanceDebug, performanceDebug || integrationTestMode, Date.now());
  watchDevBuild(panel, context, performanceEnabled, integrationTestMode);

  DashboardPanel.create(platform, createChannel(panel, context, platform), {
    extensionVersion: String(context.extension.packageJSON['version'] ?? 'unknown'),
    integrationTestMode,
    speculativeStartup: true,
    createdAt,
    ...(initialManifestPath === undefined ? {} : { initialManifestPath }),
  });
}
