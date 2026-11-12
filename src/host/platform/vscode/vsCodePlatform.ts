/** HostPlatform on the VS Code extension API. */

import { readFileSync } from 'node:fs';

import * as vscode from 'vscode';

import type { KeyValueStore } from '../../../core/cache/keyValueStore.js';
import type {
  CancellationToken,
  Disposable,
  FilePosition,
  FileSearch,
  HostPlatform,
  ProcessRequest,
  ProgressReporter,
  QuickPickItem,
  QuickPickOptions,
  RunningProcess,
  WorkspaceFolder,
} from '../hostPlatform.js';
import { REGISTRY_CACHE_STORAGE_KEY } from '../../../core/cache/persistentEtagStore.js';
import { editorActionFailureText, runtimeFailureLine } from '../../../core/diagnostics.js';
import type { RuntimeFailureContext } from '../../../core/diagnostics.js';
import { fireAndForget } from '../../../core/fireAndForget.js';
import { createCacheStore, migrateStoreKeys } from '../fileKeyValueStore.js';
import { watchGitHead } from './gitHead.js';
import { openScopedSettings } from './settingsScope.js';

const SETTINGS_SECTION = 'packageawy';

/** A VS Code token that follows `token`, for APIs that need the real type. */
function toVsCodeToken(token: CancellationToken | undefined): {
  token: vscode.CancellationToken | undefined;
  dispose(): void;
} {
  if (token === undefined) return { token: undefined, dispose: () => undefined };
  const source = new vscode.CancellationTokenSource();
  if (token.isCancellationRequested) source.cancel();
  const subscription = token.onCancellationRequested(() => source.cancel());
  return {
    token: source.token,
    dispose: () => {
      subscription.dispose();
      source.dispose();
    },
  };
}

export class VsCodePlatform implements HostPlatform {
  /** Created on first use so a session with no failures adds no output channel. */
  private logChannel: vscode.LogOutputChannel | undefined;
  readonly workspaceState: KeyValueStore;
  readonly globalState: KeyValueStore;
  readonly cacheStore: KeyValueStore;

  constructor(context: Pick<vscode.ExtensionContext, 'workspaceState' | 'globalState' | 'globalStorageUri'>) {
    this.workspaceState = context.workspaceState;
    this.globalState = context.globalState;
    // Registry responses live in files under the extension's global storage
    // folder, not in global state, which VS Code loads as one value.
    // When that folder cannot be written, the cache stays in global state.
    const cache = createCacheStore(vscode.Uri.joinPath(context.globalStorageUri, 'cache').fsPath, context.globalState);
    this.cacheStore = cache.store;
    if (cache.fileBacked) {
      migrateStoreKeys(context.globalState, this.cacheStore, [REGISTRY_CACHE_STORAGE_KEY]).catch(() => undefined);
    }
  }

  log(line: string): void {
    this.channel().warn(line);
  }

  /** Opens the Packageawy log (Packageawy: Show Log). */
  showLog(): void {
    this.channel().show(true);
  }

  dispose(): void {
    this.logChannel?.dispose();
    this.logChannel = undefined;
  }

  private channel(): vscode.LogOutputChannel {
    this.logChannel ??= vscode.window.createOutputChannel('Packageawy', { log: true });
    return this.logChannel;
  }

  workspaceFolders(): readonly WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      id: folder.uri.toString(),
      name: folder.name,
      path: folder.uri.fsPath,
    }));
  }

  isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  getSetting<T>(key: string, defaultValue: T, resourcePath?: string): T {
    const scope = resourcePath === undefined ? undefined : vscode.Uri.file(resourcePath);
    return vscode.workspace.getConfiguration(SETTINGS_SECTION, scope).get<T>(key, defaultValue);
  }

  onDidChangeSetting(key: string, listener: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS_SECTION}.${key}`)) listener();
    });
  }

  async updateWorkspaceSetting(key: string, value: unknown): Promise<void> {
    // getSetting reads without a resource scope, so the workspace target is
    // the value it sees, in single-folder and multi-root windows alike.
    await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(key, value, vscode.ConfigurationTarget.Workspace);
  }

  async findFiles(search: FileSearch, token?: CancellationToken): Promise<string[]> {
    const folderUri = vscode.Uri.parse(search.folder.id);
    const base = search.dir === '' ? folderUri : vscode.Uri.joinPath(folderUri, search.dir);
    const cancellation = toVsCodeToken(token);
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(base, search.include),
        search.exclude,
        search.maxResults,
        cancellation.token
      );
      return uris.map((uri) => uri.fsPath);
    } finally {
      cancellation.dispose();
    }
  }

  async statFile(filePath: string): Promise<{ size: number }> {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return { size: stat.size };
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  }

  watchFiles(baseDir: string, glob: string, listener: (filePath: string) => void): Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(baseDir), glob));
    const onEvent = (uri: vscode.Uri): void => listener(uri.fsPath);
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    watcher.onDidDelete(onEvent);
    return watcher;
  }

  watchGitHead(projectPath: string, onHeadChanged: () => void): Promise<Disposable | undefined> {
    return watchGitHead(projectPath, onHeadChanged);
  }

  async withProgress<T>(
    title: string,
    task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => task(progress, token)
    );
  }

  // A notification that fails to show has nowhere else to go, so it is only logged.
  showInformationMessage(message: string): void {
    fireAndForget(vscode.window.showInformationMessage(message), this.logFailure('notification'));
  }

  showWarningMessage(message: string): void {
    fireAndForget(vscode.window.showWarningMessage(message), this.logFailure('notification'));
  }

  showErrorMessage(message: string): void {
    fireAndForget(vscode.window.showErrorMessage(message), this.logFailure('notification'));
  }

  private logFailure(context: RuntimeFailureContext): (error: unknown) => undefined {
    return (error) => {
      this.log(runtimeFailureLine(context, error));
    };
  }

  /** The user asked for this, so a refusal is logged and also said once. */
  private reportEditorActionFailure(action: 'open-file' | 'open-link' | 'open-settings'): (error: unknown) => undefined {
    return (error) => {
      this.log(runtimeFailureLine(action, error));
      this.showErrorMessage(editorActionFailureText(action));
    };
  }

  async showModalWarning(message: string, detail: string, actions: readonly string[]): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions);
  }

  async showQuickPick<T>(
    items: readonly QuickPickItem<T>[],
    options: QuickPickOptions,
    token?: CancellationToken
  ): Promise<T | undefined> {
    const cancellation = toVsCodeToken(token);
    try {
      const picked = await vscode.window.showQuickPick(
        items,
        {
          title: options.title,
          placeHolder: options.placeholder,
          matchOnDescription: options.matchOnDescription,
          matchOnDetail: options.matchOnDetail,
        },
        cancellation.token
      );
      return picked?.value;
    } finally {
      cancellation.dispose();
    }
  }

  async runProcess(request: ProcessRequest): Promise<RunningProcess> {
    const execution = new vscode.ProcessExecution(request.executable, [...request.args], { cwd: request.cwd });
    const task = new vscode.Task(
      { type: 'packageawy.upgrade', package: request.scope },
      vscode.TaskScope.Workspace,
      request.title,
      'Packageawy',
      execution
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };
    const started = await vscode.tasks.executeTask(task);
    return {
      // onDidEndTaskProcess fires for every task in the workspace, so filter to this one.
      onDidExit: (listener) =>
        vscode.tasks.onDidEndTaskProcess((event) => {
          if (event.execution !== started) return;
          listener(event.exitCode);
        }),
    };
  }

  openFile(filePath: string, position?: FilePosition): void {
    fireAndForget(vscode.window.showTextDocument(vscode.Uri.file(filePath)).then((editor) => {
      if (position === undefined) return;
      const start = new vscode.Position(Math.max(0, position.line - 1), Math.max(0, position.column - 1));
      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenter);
    }), this.reportEditorActionFailure('open-file'));
  }

  openExternal(url: string): void {
    fireAndForget(vscode.env.openExternal(vscode.Uri.parse(url)), this.reportEditorActionFailure('open-link'));
  }

  openSettings(key: string, resourcePath?: string): void {
    const fullKey = `${SETTINGS_SECTION}.${key}`;
    if (resourcePath === undefined) {
      fireAndForget(
        vscode.commands.executeCommand('workbench.action.openSettings', fullKey),
        this.reportEditorActionFailure('open-settings')
      );
      return;
    }
    openScopedSettings(
      {
        inspect: (resource) => vscode.workspace.getConfiguration(SETTINGS_SECTION, vscode.Uri.file(resource)).inspect(key),
        // A .code-workspace file means separate workspace and folder settings.
        multiRoot: vscode.workspace.workspaceFile !== undefined,
        workspaceFolderFor: (resource) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resource))?.uri.fsPath,
        readFile: (filePath) => {
          try {
            return readFileSync(filePath, 'utf8');
          } catch {
            return undefined;
          }
        },
        executeCommand: (command, argument) => {
          fireAndForget(vscode.commands.executeCommand(command, argument), this.reportEditorActionFailure('open-settings'));
        },
        openFile: (filePath, position) => this.openFile(filePath, position),
      },
      fullKey,
      resourcePath
    );
  }
}
