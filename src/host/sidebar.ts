/**
 * The Packageawy view in the Activity Bar. It has no items of its own. Its welcome
 * content offers the dashboard, and revealing the view opens the dashboard directly.
 */

import * as vscode from 'vscode';

export const SIDEBAR_VIEW_ID = 'packageawy.home';

class EmptyTreeProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }

  getChildren(): never[] {
    return [];
  }
}

export function registerSidebar(openDashboard: () => void): vscode.Disposable {
  const view = vscode.window.createTreeView(SIDEBAR_VIEW_ID, { treeDataProvider: new EmptyTreeProvider() });
  // Fires when the user clicks the Activity Bar icon. A view that is already visible at
  // startup does not fire, so restoring the sidebar never opens the dashboard on its own.
  const visibility = view.onDidChangeVisibility((event) => {
    if (event.visible) openDashboard();
  });
  return vscode.Disposable.from(view, visibility);
}
