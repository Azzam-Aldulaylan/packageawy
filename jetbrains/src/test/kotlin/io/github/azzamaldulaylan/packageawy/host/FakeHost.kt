package io.github.azzamaldulaylan.packageawy.host

import com.google.gson.JsonElement
import io.github.azzamaldulaylan.packageawy.rpc.CancelSignal
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue

/** Records every call. Dialogs answer with the configured values. */
class FakeHost : HostServices {
    val events = LinkedBlockingQueue<String>()
    val messages = LinkedBlockingQueue<Pair<Severity, String>>()
    val webview = CopyOnWriteArrayList<JsonElement>()
    val fileListeners = CopyOnWriteArrayList<(String) -> Unit>()
    var modalAnswer: String? = null
    var pickAnswer: Int? = null
    var holdQuickPick = false
    var failProcessStart = false
    var hasRepository = true
    val openWatches = CopyOnWriteArrayList<String>()

    override fun showMessage(severity: Severity, message: String) {
        messages.add(severity to message)
    }

    override fun showModal(message: String, detail: String, actions: List<String>): CompletableFuture<String?> {
        events.add("modal:$message:${actions.joinToString("|")}")
        return CompletableFuture.completedFuture(modalAnswer)
    }

    override fun showQuickPick(items: List<QuickPickEntry>, settings: QuickPickSettings, cancel: CancelSignal): CompletableFuture<Int?> {
        events.add("pick:${items.joinToString("|") { it.label }}:${settings.title}")
        val result = CompletableFuture<Int?>()
        if (holdQuickPick) {
            cancel.onCancel { result.complete(null).also { events.add("pick-cancelled") } }
        } else {
            result.complete(pickAnswer)
        }
        return result
    }

    override fun startProcess(request: ProcessStart, onExit: (Int?) -> Unit) {
        if (failProcessStart) throw IllegalStateException("no such executable")
        events.add("process:${request.executable}:${request.args.joinToString(" ")}:${request.scope}")
        Thread {
            val code = ProcessBuilder(listOf(request.executable) + request.args).start().waitFor()
            onExit(code)
        }.start()
    }

    override fun openFile(path: String, line: Int?, column: Int?) {
        events.add("openFile:$path:$line:$column")
    }

    override fun openExternal(url: String) {
        events.add("openExternal:$url")
    }

    override fun openSettings(key: String) {
        events.add("openSettings:$key")
    }

    override fun startProgress(id: String, title: String, onCancel: () -> Unit) {
        events.add("progress-start:$id:$title")
    }

    override fun reportProgress(id: String, message: String?, increment: Double?) {
        events.add("progress-report:$id:$message:$increment")
    }

    override fun endProgress(id: String) {
        events.add("progress-end:$id")
    }

    override fun postToWebview(message: JsonElement) {
        webview.add(message)
        events.add("webview:$message")
    }

    override fun revealWebview() {
        events.add("reveal")
    }

    override fun watchFiles(baseDir: String, glob: String, onChange: (String) -> Unit): AutoCloseable {
        openWatches.add("$baseDir|$glob")
        fileListeners.add(onChange)
        events.add("watch:$glob")
        return AutoCloseable {
            openWatches.remove("$baseDir|$glob")
            fileListeners.remove(onChange)
            events.add("unwatch:$glob")
        }
    }

    override fun watchGitHead(projectPath: String, onChange: () -> Unit): AutoCloseable? {
        events.add("watchHead:$projectPath")
        return if (hasRepository) AutoCloseable { events.add("unwatchHead:$projectPath") } else null
    }
}
