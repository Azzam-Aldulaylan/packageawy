import * as vscode from 'vscode';

/** Identity is local to this launch. Nothing is restored by terminal name after restart. */
export class TaskTerminal {
  private readonly existing = new Set(vscode.window.terminals);
  private readonly starts = new Map<vscode.TaskExecution, number>();
  private readonly subscriptions: vscode.Disposable[];
  private execution: vscode.TaskExecution | undefined;
  private readonly pendingStarts = new Set<vscode.TaskExecution>();
  private readonly pendingChanges = new Set<() => void>();
  private pid: number | undefined;
  private terminal: vscode.Terminal | undefined;
  private exitCode: number | undefined;
  private ended = false;
  private invalid = false;
  private generation = 0;

  constructor() {
    this.subscriptions = [
      vscode.tasks.onDidStartTask((event) => {
        const execution = event.execution.task.execution;
        if (!(execution instanceof vscode.ProcessExecution) && !(execution instanceof vscode.ShellExecution)) return;
        // Until its pid arrives, another task may be reusing our terminal.
        this.pendingStarts.add(event.execution);
      }),
      vscode.tasks.onDidEndTask((event) => {
        this.pendingStarts.delete(event.execution);
        this.wakePendingCleanup();
      }),
      vscode.tasks.onDidStartTaskProcess((event) => {
        this.pendingStarts.delete(event.execution);
        this.wakePendingCleanup();
        // Only a matching pid makes another execution an ownership conflict.
        if (this.pid === event.processId && event.execution !== this.execution) {
          this.dispose();
          return;
        }
        this.starts.set(event.execution, event.processId);
        if (event.execution === this.execution) this.identify(event.processId);
      }),
      vscode.window.onDidOpenTerminal(() => { this.generation += 1; this.capture().catch(() => this.dispose()); }),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === this.terminal) this.dispose();
      }),
    ];
  }

  started(execution: vscode.TaskExecution): void {
    this.execution = execution;
    const pid = this.starts.get(execution);
    if (pid !== undefined) this.identify(pid);
  }

  finished(exitCode: number | undefined): void {
    this.ended = true;
    this.exitCode = exitCode;
    if (exitCode !== 0) this.dispose();
  }

  /** Called only after Packageawy has also settled and recorded a successful run. */
  async closeAfterSuccess(): Promise<void> {
    try {
      if (!this.ended || this.exitCode !== 0) return;
      while (!this.invalid) {
        const generation = this.generation;
        await this.capture();
        if (generation !== this.generation) continue;
        const terminal = this.terminal;
        if (this.invalid || terminal === undefined) return;
        const pid = await terminal.processId;
        if (generation !== this.generation) continue;
        if (this.invalid) return;
        if ([...this.pendingStarts].some((other) => other !== this.execution)) {
          // Keep tracking ownership until the native start has a pid or ends.
          await new Promise<void>((resolve) => { this.pendingChanges.add(resolve); });
          continue;
        }
        if (pid === this.pid && vscode.window.terminals.includes(terminal)) {
          terminal.dispose();
        }
        return;
      }
    } catch {
      // Missing identity, rejected pid queries and closed terminals are all leave-open cases.
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    this.invalid = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.starts.clear();
    this.pendingStarts.clear();
    this.wakePendingCleanup();
  }

  private wakePendingCleanup(): void {
    for (const resolve of this.pendingChanges) resolve();
    this.pendingChanges.clear();
  }

  private identify(pid: number): void {
    if (this.pid !== undefined || [...this.starts].some(([other, value]) => other !== this.execution && value === pid)) {
      this.dispose();
      return;
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) { this.dispose(); return; }
    this.pid = pid;
    this.capture().catch(() => this.dispose());
  }

  private async capture(): Promise<void> {
    if (this.invalid || this.pid === undefined) return;
    const generation = this.generation;
    try {
      const terminals = [...vscode.window.terminals];
      const pids = await Promise.all(terminals.map((terminal) => terminal.processId));
      if (this.invalid || generation !== this.generation) return;
      const matches = terminals.filter((_, index) => pids[index] === this.pid);
      if (matches.length > 1) { this.dispose(); return; }
      const match = matches[0];
      if (match === undefined) return;
      // A pre-existing console could already belong to another run. Leave reused consoles open.
      if (this.existing.has(match) || (this.terminal !== undefined && this.terminal !== match)) {
        this.dispose();
        return;
      }
      this.terminal = match;
      if (!vscode.window.terminals.includes(match)) this.dispose();
    } catch {
      this.dispose();
    }
  }
}
