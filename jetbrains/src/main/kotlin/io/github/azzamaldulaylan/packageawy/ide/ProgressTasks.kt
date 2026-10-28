package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The progress notifications: one cancellable background task per progress id. */
class ProgressTasks(private val project: Project) {
    private class State {
        val finished = CountDownLatch(1)
        @Volatile var message: String? = null
        @Volatile var percent: Double? = null
    }

    private val running = ConcurrentHashMap<String, State>()

    fun start(id: String, title: String, onCancel: () -> Unit) {
        val state = State()
        if (running.putIfAbsent(id, state) != null) return
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, true) {
                override fun run(indicator: ProgressIndicator) {
                    indicator.isIndeterminate = true
                    while (!state.finished.await(100, TimeUnit.MILLISECONDS)) {
                        if (indicator.isCanceled) {
                            running.remove(id)
                            onCancel()
                            return
                        }
                        state.message?.let { indicator.text2 = it }
                        state.percent?.let {
                            indicator.isIndeterminate = false
                            indicator.fraction = (it / 100.0).coerceIn(0.0, 1.0)
                        }
                    }
                }
            })
        }
    }

    fun report(id: String, message: String?, increment: Double?) {
        val state = running[id] ?: return
        if (message != null) state.message = message
        if (increment != null) state.percent = (state.percent ?: 0.0) + increment
    }

    fun end(id: String) {
        running.remove(id)?.finished?.countDown()
    }

    fun endAll() {
        for (id in running.keys.toList()) end(id)
    }
}
