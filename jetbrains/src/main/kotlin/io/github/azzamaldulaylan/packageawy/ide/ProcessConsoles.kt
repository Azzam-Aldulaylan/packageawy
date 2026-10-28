package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import io.github.azzamaldulaylan.packageawy.host.ProcessStart
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

/** `process/start`: runs a command in a Run tool window tab, one tab per scope. */
class ProcessConsoles(private val project: Project) {
    private val tabs = ConcurrentHashMap<String, RunContentDescriptor>()

    /** Throws when the process cannot start. */
    fun start(request: ProcessStart, onExit: (Int?) -> Unit) {
        val commandLine = GeneralCommandLine(listOf(resolve(request.executable)) + request.args)
            .withWorkingDirectory(File(request.cwd).toPath())
            .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
            .withCharset(StandardCharsets.UTF_8)
        val handler = OSProcessHandler(commandLine)
        handler.addProcessListener(object : ProcessListener {
            override fun processTerminated(event: ProcessEvent) = onExit(event.exitCode)
        })
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) {
                handler.startNotify()
                handler.destroyProcess()
                return@invokeLater
            }
            val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
            console.attachToProcess(handler)
            val descriptor = RunContentDescriptor(console, handler, console.component, request.title)
            val executor = DefaultRunExecutor.getRunExecutorInstance()
            RunContentManager.getInstance(project).showRunContent(executor, descriptor, tabs[request.scope])
            tabs[request.scope] = descriptor
            handler.startNotify()
        }
    }

    /** Resolves a bare command such as `npm` against the user's shell PATH. */
    private fun resolve(executable: String): String {
        if (File(executable).isAbsolute) return executable
        return PathEnvironmentVariableUtil.findExecutableInPathOnAnyOS(executable)?.absolutePath ?: executable
    }
}
