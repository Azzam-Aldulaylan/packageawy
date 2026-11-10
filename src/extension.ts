/**
 * Composition root. Keep this thin: wiring only, no logic.
 *
 * Anything with behavior worth testing belongs in src/core (pure, no vscode)
 * or src/host (editor-facing adapters behind HostPlatform).
 */

import * as vscode from 'vscode';

import { createPerformanceSession } from './core/performance/measurement.js';
import { DashboardPanel } from './host/dashboardPanel.js';
import type { DashboardPanelIntegrationTestSnapshot } from './host/dashboardPanel.js';
import { OPEN_MANIFEST_UNAVAILABLE_MESSAGE } from './host/openManifestTarget.js';
import { openManifestInDashboard, showDashboard } from './host/platform/vscode/dashboardWebview.js';
import { registerSidebar } from './host/platform/vscode/sidebar.js';
import { VsCodePlatform } from './host/platform/vscode/vsCodePlatform.js';

export interface PackageawyIntegrationTestApi {
  dashboard: {
    snapshot(): DashboardPanelIntegrationTestSnapshot;
    dispatch(message: unknown): Promise<void>;
  };
}

export function activate(context: vscode.ExtensionContext): void | PackageawyIntegrationTestApi {
  const performanceEnabled = vscode.workspace
    .getConfiguration('packageawy')
    .get<boolean>('debug.performance', false);
  const performance = createPerformanceSession('Packageawy activation', performanceEnabled);
  const endActivation = performance.start('command registration');
  // The manifest declares untrustedWorkspaces.supported = false, so VS Code
  // won't activate us in an untrusted workspace at all. This check is a
  // second guard in case that declaration is ever loosened: reading
  // .npmrc and running npm install are both unsafe against untrusted content.
  if (!vscode.workspace.isTrusted) {
    endActivation({ trusted: false });
    performance.finish({ trusted: false });
    return;
  }

  const platform = new VsCodePlatform(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('packageawy.open', () => {
      showDashboard(context, platform);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('packageawy.openPackageJson', (uri?: vscode.Uri) => {
      // From the Command Palette there is no clicked file: use the active editor's.
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target === undefined || target.scheme !== 'file') {
        platform.showInformationMessage(OPEN_MANIFEST_UNAVAILABLE_MESSAGE);
        return;
      }
      void openManifestInDashboard(context, platform, target.fsPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('packageawy.refresh', () => {
      void DashboardPanel.refresh();
    })
  );

  context.subscriptions.push(registerSidebar(() => showDashboard(context, platform)));
  endActivation({ trusted: true });
  performance.finish({ trusted: true });

  if (
    context.extensionMode === vscode.ExtensionMode.Test ||
    process.env['PACKAGEAWY_EXTENSION_TEST'] === '1'
  ) {
    return {
      dashboard: {
        snapshot: () => DashboardPanel.integrationTestSnapshot(),
        dispatch: (message) => DashboardPanel.dispatchIntegrationTestMessage(message),
      },
    };
  }
}

export function deactivate(): void {
  // Disposables are registered on context.subscriptions. Nothing extra here.
}
