/**
 * Opens a setting where the value in effect comes from, so the user edits
 * the value that actually applies. Kept free of `vscode` imports: the VS
 * Code platform passes in the few editor calls this needs.
 *
 * VS Code 1.90 cannot open the Settings editor on one chosen folder:
 * `workbench.action.openFolderSettings` always asks which folder, and the
 * open-settings commands accept no folder or target argument. So a value
 * set by one folder of a multi-root workspace opens that folder's
 * `.vscode/settings.json` at the setting instead.
 */

import * as path from 'node:path';

import type { FilePosition } from '../hostPlatform.js';

/** The subset of `WorkspaceConfiguration.inspect` this needs. */
export interface SettingInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

export interface SettingsEditor {
  inspect(resourcePath: string): SettingInspection | undefined;
  /** True when the window has a .code-workspace file, so folders have their own settings. */
  multiRoot: boolean;
  /** The path of the workspace folder that contains `resourcePath`. */
  workspaceFolderFor(resourcePath: string): string | undefined;
  readFile(filePath: string): string | undefined;
  executeCommand(command: string, argument: unknown): void;
  openFile(filePath: string, position?: FilePosition): void;
}

/** Where `"fullKey"` is written in a settings file, 1-based. */
export function settingPosition(text: string, fullKey: string): FilePosition | undefined {
  const index = text.indexOf(JSON.stringify(fullKey));
  if (index < 0) return undefined;
  const before = text.slice(0, index).split('\n');
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

/**
 * Folder settings win over workspace settings, which win over user settings.
 * The most specific scope that sets a value is the one that decides it.
 * A single-folder window has no separate folder scope: there the folder
 * value is the workspace value.
 */
export function openScopedSettings(editor: SettingsEditor, fullKey: string, resourcePath: string): void {
  const inspection = editor.inspect(resourcePath);
  if (editor.multiRoot && inspection?.workspaceFolderValue !== undefined) {
    const folder = editor.workspaceFolderFor(resourcePath);
    if (folder !== undefined) {
      const file = path.join(folder, '.vscode', 'settings.json');
      const text = editor.readFile(file);
      const position = text === undefined ? undefined : settingPosition(text, fullKey);
      editor.openFile(file, position);
      return;
    }
    editor.executeCommand('workbench.action.openFolderSettings', { query: fullKey });
    return;
  }
  if (inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined) {
    editor.executeCommand('workbench.action.openWorkspaceSettings', { query: fullKey });
    return;
  }
  editor.executeCommand('workbench.action.openSettings', `@id:${fullKey}`);
}
