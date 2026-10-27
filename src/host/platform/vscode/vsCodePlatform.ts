/** HostPlatform on the VS Code extension API. */

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
import { watchGitHead } from './gitHead.js';

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
  readonly workspaceState: KeyValueStore;
  readonly globalState: KeyValueStore;

  constructor(context: Pick<vscode.ExtensionContext, 'workspaceState' | 'globalState'>) {
    this.workspaceState = context.workspaceState;
    this.globalState = context.globalState;
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

  getSetting<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<T>(key, defaultValue);
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

  showInformationMessage(message: string): void {
    void vscode.window.showInformationMessage(message);
  }

  showWarningMessage(message: string): void {
    void vscode.window.showWarningMessage(message);
  }

  showErrorMessage(message: string): void {
    void vscode.window.showErrorMessage(message);
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
    void vscode.window.showTextDocument(vscode.Uri.file(filePath)).then((editor) => {
      if (position === undefined) return;
      const start = new vscode.Position(Math.max(0, position.line - 1), Math.max(0, position.column - 1));
      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenter);
    });
  }

  openExternal(url: string): void {
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  openSettings(key: string): void {
    void vscode.commands.executeCommand('workbench.action.openSettings', `${SETTINGS_SECTION}.${key}`);
  }
}
