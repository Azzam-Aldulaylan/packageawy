package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessTerminatedListener
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import io.github.azzamaldulaylan.packageawy.host.ProcessStart
import io.github.azzamaldulaylan.packageawy.host.SuccessfulProcess
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** `process/start`: runs a command in a Run tool window tab, one tab per scope. */
class ProcessConsoles(private val project: Project) {
    private val tabs = ConcurrentHashMap<String, RunContentDescriptor>()
    private val completions = ConcurrentHashMap<String, ConsoleCompletion<RunContentDescriptor>>()

    /** Throws when the process cannot start. */
    fun start(request: ProcessStart, onExit: (Int?) -> Unit): SuccessfulProcess {
        val completion = ConsoleCompletion(tabs, request.scope,
            schedule = { ApplicationManager.getApplication().invokeLater(it) },
            available = { !project.isDisposed },
            remove = { descriptor ->
                RunContentManager.getInstance(project).removeRunContent(DefaultRunExecutor.getRunExecutorInstance(), descriptor)
            },
        )
        val handler = launch(request) { code ->
            completion.exited(code)
            onExit(code)
        }
        handler.addProcessListener(object : ProcessListener {
            override fun processWillTerminate(event: ProcessEvent, willBeDestroyed: Boolean) {
                if (willBeDestroyed) completion.cancel()
            }
        })
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) {
                // No console to show it in. The install is left to finish, as in VS Code.
                handler.startNotify()
                return@invokeLater
            }
            val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
            console.attachToProcess(handler)
            val descriptor = RunContentDescriptor(console, handler, console.component, request.title)
            val executor = DefaultRunExecutor.getRunExecutorInstance()
            RunContentManager.getInstance(project).showRunContent(executor, descriptor, tabs[request.scope])
            completions.put(request.scope, completion)?.disposed()
            tabs[request.scope] = descriptor
            completion.shown(descriptor)
            Disposer.register(descriptor) {
                completion.disposed()
                completions.remove(request.scope, completion)
            }
            handler.startNotify()
        }
        return object : SuccessfulProcess {
            override fun close() {
                completion.cancel()
                handler.destroyProcess()
            }

            override fun reveal(): CompletableFuture<Boolean> = completion.reveal { descriptor ->
                RunContentManager.getInstance(project).showRunContent(DefaultRunExecutor.getRunExecutorInstance(), descriptor)
            }
            override fun closeAfterSuccess() = completion.closeAfterSuccess()
            override fun onConsoleDisposed(listener: () -> Unit) = completion.onDisposed(listener)
        }
    }

    companion object {
        /**
         * Starts the process with literal arguments and no shell. Output is
         * held until `startNotify`. [onExit] runs once, also when the user
         * stops the process from the console.
         */
        fun launch(request: ProcessStart, onExit: (Int?) -> Unit): OSProcessHandler {
            val handler = OSProcessHandler(commandLine(request))
            // Prints "Process finished with exit code N" in the console.
            ProcessTerminatedListener.attach(handler)
            val reported = AtomicBoolean(false)
            handler.addProcessListener(object : ProcessListener {
                override fun processTerminated(event: ProcessEvent) {
                    if (reported.compareAndSet(false, true)) onExit(event.exitCode)
                }
            })
            return handler
        }

        fun commandLine(request: ProcessStart): GeneralCommandLine =
            GeneralCommandLine(listOf(resolve(request.executable)) + request.args)
                .withWorkingDirectory(File(request.cwd).toPath())
                .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
                .withCharset(StandardCharsets.UTF_8)

        /** Resolves a bare command such as `npm` against the user's shell PATH. */
        private fun resolve(executable: String): String {
            if (File(executable).isAbsolute) return executable
            return PathEnvironmentVariableUtil.findExecutableInPathOnAnyOS(executable)?.absolutePath ?: executable
        }
    }
}

/** Keeps delayed UI cleanup tied to the descriptor that actually ran the successful process. */
internal class ConsoleCompletion<T : Any>(
    private val tabs: ConcurrentHashMap<String, T>,
    private val scope: String,
    private val schedule: (() -> Unit) -> Unit,
    private val available: () -> Boolean,
    private val remove: (T) -> Unit,
) {
    @Volatile private var descriptor: T? = null
    @Volatile private var exitCode: Int? = null
    private val cancelled = AtomicBoolean(false)
    private val requested = AtomicBoolean(false)
    private var disposed = false
    private val disposalListeners = mutableSetOf<() -> Unit>()

    fun onDisposed(listener: () -> Unit): AutoCloseable {
        val notify = synchronized(this) {
            if (disposed) true else { disposalListeners.add(listener); false }
        }
        if (notify) listener()
        return AutoCloseable { synchronized(this) { disposalListeners.remove(listener) } }
    }

    fun disposed() {
        val listeners = synchronized(this) {
            if (disposed) return
            disposed = true
            cancel()
            descriptor?.let { value ->
                tabs.computeIfPresent(scope) { _, current -> if (current === value) null else current }
            }
            descriptor = null
            disposalListeners.toList().also { disposalListeners.clear() }
        }
        listeners.forEach { it() }
    }

    fun shown(value: T) { descriptor = value }
    fun exited(code: Int?) { exitCode = code }
    fun cancel() { cancelled.set(true) }

    fun reveal(show: (T) -> Unit): CompletableFuture<Boolean> {
        val result = CompletableFuture<Boolean>()
        schedule {
            val value = descriptor
            if (!available() || value == null || tabs[scope] !== value) result.complete(false)
            else try { show(value); result.complete(true) } catch (_: Exception) { result.complete(false) }
        }
        return result
    }

    fun closeAfterSuccess() {
        val value = descriptor ?: return
        if (exitCode != 0 || cancelled.get() || !requested.compareAndSet(false, true)) return
        schedule {
            if (available() && !cancelled.get() && tabs[scope] === value) {
                remove(value)
                tabs.computeIfPresent(scope) { _, current -> if (current === value) null else current }
            }
        }
    }
}
