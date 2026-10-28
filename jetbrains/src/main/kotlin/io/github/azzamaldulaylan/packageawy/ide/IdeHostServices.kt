package io.github.azzamaldulaylan.packageawy.ide

import com.google.gson.JsonElement
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import io.github.azzamaldulaylan.packageawy.host.HostServices
import io.github.azzamaldulaylan.packageawy.host.ProcessStart
import io.github.azzamaldulaylan.packageawy.host.QuickPickEntry
import io.github.azzamaldulaylan.packageawy.host.QuickPickSettings
import io.github.azzamaldulaylan.packageawy.host.Severity
import io.github.azzamaldulaylan.packageawy.rpc.CancelSignal
import io.github.azzamaldulaylan.packageawy.settings.PackageawyConfigurable
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import javax.swing.JList

/** [HostServices] on the IntelliJ Platform for one project. */
class IdeHostServices(
    private val project: Project,
    parent: Disposable,
    private val postToWebview: (JsonElement) -> Unit,
) : HostServices {
    private val progress = ProgressTasks(project)
    private val processes = ProcessConsoles(project)
    private val fileEvents = FileEvents(project, parent)

    override fun showMessage(severity: Severity, message: String) {
        val type = when (severity) {
            Severity.INFO -> NotificationType.INFORMATION
            Severity.WARNING -> NotificationType.WARNING
            Severity.ERROR -> NotificationType.ERROR
        }
        notify(project, message, type)
    }

    override fun showModal(message: String, detail: String, actions: List<String>): CompletableFuture<String?> {
        val result = CompletableFuture<String?>()
        onEdt(result) {
            val text = if (detail.isEmpty()) message else "$message\n\n$detail"
            val options = (actions + "Cancel").toTypedArray()
            val index = Messages.showDialog(project, text, "Packageawy", options, actions.size, Messages.getWarningIcon())
            result.complete(actions.getOrNull(index))
        }
        return result
    }

    override fun showQuickPick(items: List<QuickPickEntry>, settings: QuickPickSettings, cancel: CancelSignal): CompletableFuture<Int?> {
        val result = CompletableFuture<Int?>()
        onEdt(result) {
            val builder = JBPopupFactory.getInstance().createPopupChooserBuilder(items.indices.toList())
                .setRenderer(QuickPickRenderer(items))
                .setNamerForFiltering { index ->
                    val item = items[index]
                    listOfNotNull(
                        item.label,
                        item.description?.takeIf { settings.matchOnDescription },
                        item.detail?.takeIf { settings.matchOnDetail },
                    ).joinToString(" ")
                }
                .setItemChosenCallback { index -> result.complete(index) }
                .addListener(object : JBPopupListener {
                    override fun onClosed(event: LightweightWindowEvent) {
                        ApplicationManager.getApplication().invokeLater { result.complete(null) }
                    }
                })
            if (settings.title.isNotEmpty()) builder.setTitle(settings.title)
            if (settings.placeholder.isNotEmpty()) builder.setAdText(settings.placeholder)
            val popup = builder.createPopup()
            cancel.onCancel { ApplicationManager.getApplication().invokeLater { popup.cancel() } }
            popup.showCenteredInCurrentWindow(project)
        }
        return result
    }

    override fun startProcess(request: ProcessStart, onExit: (Int?) -> Unit) = processes.start(request, onExit)

    override fun openFile(path: String, line: Int?, column: Int?) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(path)) ?: return@executeOnPooledThread
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val descriptor = if (line == null) {
                    OpenFileDescriptor(project, file)
                } else {
                    OpenFileDescriptor(project, file, (line - 1).coerceAtLeast(0), ((column ?: 1) - 1).coerceAtLeast(0))
                }
                descriptor.navigate(true)
            }
        }
    }

    override fun openExternal(url: String) = BrowserUtil.browse(url)

    override fun openSettings(key: String) {
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) ShowSettingsUtil.getInstance().showSettingsDialog(project, PackageawyConfigurable::class.java)
        }
    }

    override fun startProgress(id: String, title: String, onCancel: () -> Unit) = progress.start(id, title, onCancel)

    override fun reportProgress(id: String, message: String?, increment: Double?) = progress.report(id, message, increment)

    override fun endProgress(id: String) = progress.end(id)

    override fun postToWebview(message: JsonElement) = postToWebview.invoke(message)

    override fun revealWebview() {
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.activate(null)
        }
    }

    override fun watchFiles(baseDir: String, glob: String, onChange: (String) -> Unit): AutoCloseable =
        fileEvents.watchFiles(baseDir, glob, onChange)

    override fun watchGitHead(projectPath: String, onChange: () -> Unit): AutoCloseable? =
        fileEvents.watchGitHead(projectPath, onChange)

    fun endAllProgress() = progress.endAll()

    private fun <T> onEdt(result: CompletableFuture<T>, action: () -> Unit) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) {
                result.complete(null)
                return@invokeLater
            }
            try {
                action()
            } catch (e: Exception) {
                result.completeExceptionally(e)
            }
        }
    }

    private class QuickPickRenderer(private val items: List<QuickPickEntry>) : ColoredListCellRenderer<Int>() {
        override fun customizeCellRenderer(list: JList<out Int>, value: Int, index: Int, selected: Boolean, hasFocus: Boolean) {
            val item = items[value]
            append(item.label)
            item.description?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
            item.detail?.let { append("  $it", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES) }
        }
    }

    companion object {
        const val TOOL_WINDOW_ID = "Packageawy"

        fun notify(project: Project?, message: String, type: NotificationType) {
            NotificationGroupManager.getInstance().getNotificationGroup("Packageawy")
                .createNotification(StringUtil.escapeXmlEntities(message), type)
                .notify(project)
        }
    }
}
