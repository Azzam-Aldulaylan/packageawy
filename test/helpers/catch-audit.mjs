import fs from 'node:fs';
import ts from 'typescript';

export const catchTable = JSON.parse(fs.readFileSync(new URL('./rollback-catch-table.json', import.meta.url), 'utf8'));

/** Extract the actual handler, rather than mirroring its classification in a test. */
export function catchHandlers(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const handlers = [];
  function visit(node) {
    if (ts.isCatchClause(node)) handlers.push({ node, parameter: node.variableDeclaration?.name.getText(source) ?? 'auditError', body: node.block.getText(source) });
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
      const callback = node.arguments[0];
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) throw new Error(`Unaudited catch callback in ${file}`);
      handlers.push({ node, parameter: callback.parameters[0]?.name.getText(source) ?? 'auditError',
        body: ts.isBlock(callback.body) ? callback.body.getText(source) : `{ return ${callback.body.getText(source)}; }` });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return handlers.map((handler, index) => {
    let owner = handler.node.parent;
    while (owner && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner) && !ts.isConstructorDeclaration(owner)) owner = owner.parent;
    return { ...handler, func: owner?.name?.getText(source) ?? 'constructor', id: `${file.replace('src/host/', '')}#${index + 1}`,
    line: source.getLineAndCharacterOfPosition(handler.node.getStart(source)).line + 1 };
  });
}

/**
 * Inject a TypeError at the protected operation and execute its real catch body.
 * The explicit scope supplies the same owner, domain classes and filesystem classifier
 * used by production. A single-iteration loop also supports handlers that break/continue.
 * This isolates every handler, including error-only diagnostics and nested catches that
 * cannot all be reached by one successful restore. Entry-point tests cover their wiring.
 */
export async function injectCatchTypeError(handler, scope, error) {
  const js = ts.transpileModule(`async function audit() { for (let once = 0; once < 1; once++) {
    try { throw injectedError; } catch (${handler.parameter}) ${handler.body}
  } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('scope', 'injectedError', `with (scope) { ${js}; return audit.call(receiver); }`)(scope, error);
}

/** Drive the actual coordinator/session boundary. Never settle the handle from the test. */
export async function productionEntryPointFault(t, operation) {
  const { rollbackFixture } = await import('./optional-reinstall.mjs');
  const { recoveryFixture, choices } = await import('./recovery.mjs');
  const io = await import('node:fs/promises');
  const { ProjectMutationLocks } = await import('../../out/host/projectMutationLock.js');
  const { RecoveryCoordinator } = await import('../../out/host/recovery/coordinator.js');
  const { lockKey } = await import('../../out/host/pathIdentity.js');
  const error = new TypeError(`production audit ${operation}`);
  let hits = 0, journal;
  const inject = (active, dependencyFile) => {
    journal = active;
    const native = journal.storage.fs;
    journal.storage.fs = { ...native, async rename(source, destination) {
      if ((journal.data.step === 'rollback' || operation.endsWith('recovery')) && source === dependencyFile) {
        hits++;
        throw error;
      }
      return native.rename(source, destination);
    } };
  };
  if (operation.endsWith('recovery')) {
    const f = await recoveryFixture(t, { operation: operation.startsWith('cleanup') ? 'cleanup' : 'upgrade' });
    await f.prepare();
    await io.writeFile(f.manifest, 'installed manifest');
    const locks = new ProjectMutationLocks();
    const messages = [];
    const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks,
      target: async () => f.target, post: message => messages.push(message), removed: async () => {} });
    await coordinator.start(true, (await f.inspect()).view.claim);
    const session = coordinator.session;
    inject(session.inspection.journal, f.manifest);
    await coordinator.apply(choices(await session.presentation(), 'restore'));
    return { hits, journal, unknown: session.outcomeUnknown, holder: locks.holderOf(lockKey(f.root)), messages };
  }
  const f = await rollbackFixture(t, operation === 'reinstall' ? 'removal' : operation);
  if (operation === 'reinstall') {
    f.coordinator.session.invocationResolver = () => {
      if (f.commands.includes('install')) { hits++; throw error; }
      return { executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' };
    };
  } else {
    const reserve = f.coordinator.reserve.bind(f.coordinator);
    f.coordinator.reserve = label => {
      const handle = reserve(label);
      const begin = handle.beginMutation.bind(handle);
      handle.beginMutation = async target => {
        const ok = await begin(target);
        inject(handle.journal, operation === 'transitive' ? f.project.lockfilePath : f.project.manifestPath);
        return ok;
      };
      return handle;
    };
  }
  await f.confirm();
  const handle = f.coordinator.reservation.held;
  return { hits, journal: handle.journal, unknown: handle.state === 'unknown',
    holder: f.coordinator.mutationLocks.holderOf(handle.lockKey), messages: f.messages };
}
