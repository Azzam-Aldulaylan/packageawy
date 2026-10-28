package io.github.azzamaldulaylan.packageawy.host

import com.google.gson.JsonElement
import io.github.azzamaldulaylan.packageawy.rpc.CancelSignal
import java.util.concurrent.CompletableFuture

enum class Severity { INFO, WARNING, ERROR }

data class QuickPickEntry(val label: String, val description: String?, val detail: String?)

data class QuickPickSettings(
    val title: String,
    val placeholder: String,
    val matchOnDescription: Boolean,
    val matchOnDetail: Boolean,
)

data class ProcessStart(
    val executable: String,
    val args: List<String>,
    val cwd: String,
    val title: String,
    val scope: String,
)

/** The IDE side of every client handler. The plugin implements it on the IntelliJ Platform. Tests use fakes. */
interface HostServices {
    fun showMessage(severity: Severity, message: String)

    /** Completes with the chosen action, or null when dismissed. */
    fun showModal(message: String, detail: String, actions: List<String>): CompletableFuture<String?>

    /** Completes with the chosen index, or null when dismissed or cancelled. */
    fun showQuickPick(items: List<QuickPickEntry>, settings: QuickPickSettings, cancel: CancelSignal): CompletableFuture<Int?>

    /** Starts the process in a console the user can see. Throws when it cannot start. */
    fun startProcess(request: ProcessStart, onExit: (exitCode: Int?) -> Unit)

    /** One-based line and column. */
    fun openFile(path: String, line: Int?, column: Int?)
    fun openExternal(url: String)
    fun openSettings(key: String)

    fun startProgress(id: String, title: String, onCancel: () -> Unit)
    fun reportProgress(id: String, message: String?, increment: Double?)
    fun endProgress(id: String)

    fun postToWebview(message: JsonElement)
    fun revealWebview()

    fun watchFiles(baseDir: String, glob: String, onChange: (path: String) -> Unit): AutoCloseable

    /** Null when HEAD cannot be observed for the project. */
    fun watchGitHead(projectPath: String, onChange: () -> Unit): AutoCloseable?
}
