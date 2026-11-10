/**
 * Picks which Settings editor tab to open for a setting, so the user lands
 * on the scope that supplies the value in effect. Kept free of `vscode`
 * imports so it can be tested with a plain inspect result.
 */

/** The subset of `WorkspaceConfiguration.inspect` this needs. */
export interface SettingInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

export interface SettingsCommand {
  command: 'workbench.action.openFolderSettings' | 'workbench.action.openWorkspaceSettings' | 'workbench.action.openSettings';
  query: string;
}

/**
 * Folder settings win over workspace settings, which win over user settings.
 * The most specific scope that sets a value is the one that decides it.
 * A single-folder window has no separate folder tab: there the folder value
 * is the workspace value.
 */
export function settingsCommandFor(
  fullKey: string,
  inspection: SettingInspection | undefined,
  multiRoot: boolean
): SettingsCommand {
  if (multiRoot && inspection?.workspaceFolderValue !== undefined) {
    return { command: 'workbench.action.openFolderSettings', query: fullKey };
  }
  if (inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined) {
    return { command: 'workbench.action.openWorkspaceSettings', query: fullKey };
  }
  return { command: 'workbench.action.openSettings', query: `@id:${fullKey}` };
}
