/**
 * The Packageawy view in the Activity Bar. VS Code only lets an Activity Bar icon open a
 * sidebar, so revealing the view opens the dashboard and closes the sidebar again. To the
 * user the icon behaves like a button. The welcome content is a fallback for users who move
 * the view somewhere it stays open.
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
    if (!event.visible) return;
    openDashboard();
    void vscode.commands.executeCommand('workbench.action.closeSidebar');
  });
  return vscode.Disposable.from(view, visibility);
}
