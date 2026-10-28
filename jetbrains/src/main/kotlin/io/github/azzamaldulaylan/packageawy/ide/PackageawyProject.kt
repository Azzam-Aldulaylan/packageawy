package io.github.azzamaldulaylan.packageawy.ide

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.ide.plugins.cl.PluginAwareClassLoader
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.ide.trustedProjects.TrustedProjectsListener
import com.intellij.ide.ui.LafManagerListener
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ModuleRootEvent
import com.intellij.openapi.roots.ModuleRootListener
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.util.EnvironmentUtil
import com.intellij.util.concurrency.AppExecutorUtil
import io.github.azzamaldulaylan.packageawy.host.ClientHandlers
import io.github.azzamaldulaylan.packageawy.settings.PackageawySettings
import io.github.azzamaldulaylan.packageawy.settings.SettingsListener
import io.github.azzamaldulaylan.packageawy.sidecar.Initialize
import io.github.azzamaldulaylan.packageawy.sidecar.NodeLocator
import io.github.azzamaldulaylan.packageawy.sidecar.SidecarProcess
import io.github.azzamaldulaylan.packageawy.sidecar.WorkspaceFolder
import io.github.azzamaldulaylan.packageawy.webview.IdeTheme
import io.github.azzamaldulaylan.packageawy.webview.ThemeVariables
import io.github.azzamaldulaylan.packageawy.webview.WebviewPanel
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JComponent
import javax.swing.SwingConstants

/** Owns the tool window's webview and the sidecar behind it for one project. */
@Service(Service.Level.PROJECT)
class PackageawyProject(private val project: Project) : Disposable {
    private class Session(val sidecar: SidecarProcess, val handlers: ClientHandlers, val host: IdeHostServices, val scope: Disposable) {
        @Volatile var ready = false
        @Volatile var stopping = false
        val pending = ArrayList<JsonElement>()
    }

    private val lock = Any()
    private val workspaceState = StatePaths.open(StatePaths.workspace(project.locationHash))
    private var panel: WebviewPanel? = null
    private var session: Session? = null
    private var starting = false
    private val earlyMessages = ArrayList<JsonElement>()
    private var folders: List<WorkspaceFolder> = emptyList()

    fun createComponent(contentScope: Disposable): JComponent {
        if (!JBCefApp.isSupported()) {
            return JBLabel("Packageawy needs JCEF, which this IDE runtime does not provide.", SwingConstants.CENTER)
        }
        val webview = WebviewPanel(contentScope, ::fromWebview) { startSidecar() }
        panel = webview
        val bus = ApplicationManager.getApplication().messageBus.connect(contentScope)
        bus.subscribe(LafManagerListener.TOPIC, LafManagerListener { applyTheme() })
        bus.subscribe(EditorColorsManager.TOPIC, EditorColorsListener { applyTheme() })
        Disposer.register(contentScope) {
            stopSidecar()
            panel = null
        }
        loadPage(webview)
        return webview.component
    }

    /** Stops the sidecar and reloads the page, which starts a fresh sidecar. */
    fun restart() {
        stopSidecar()
        panel?.let(::loadPage)
    }

    /** The same as the dashboard's own refresh button. */
    fun refresh() = fromWebview(JsonObject().apply { addProperty("type", "refresh") })

    fun openDevTools() = panel?.openDevTools()

    override fun dispose() {
        stopSidecar()
        workspaceState.flush()
    }

    private fun loadPage(webview: WebviewPanel) {
        val palette = IdeTheme.palette()
        val css = ThemeVariables.rootRule(ThemeVariables.from(palette), palette.dark)
        webview.load(css, palette.dark, PackageawySettings.getInstance().state.debugPerformance)
    }

    private fun applyTheme() {
        val palette = IdeTheme.palette()
        panel?.applyTheme(ThemeVariables.from(palette), palette.dark)
    }

    private fun fromWebview(message: JsonElement) {
        val current = synchronized(lock) {
            val s = session
            if (s == null || !s.ready) {
                // The page says `ready` before the sidecar is up. Keep it for after initialize.
                (s?.pending ?: earlyMessages).add(message)
                return
            }
            s
        }
        current.sidecar.connection.sendNotification("webview/didReceiveMessage", mapOf("message" to message))
    }

    private fun startSidecar() {
        synchronized(lock) {
            if (session != null || starting) return
            starting = true
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                launch()
            } catch (e: Exception) {
                LOG.warn("Could not start the Packageawy sidecar", e)
                notifyFailure(e.message ?: "Could not start the Packageawy engine.")
            } finally {
                synchronized(lock) { starting = false }
            }
        }
    }

    private fun launch() {
        val script = bundledSidecar() ?: throw IllegalStateException("The bundled Packageawy engine is missing.")
        val node = NodeLocator.find(project)
            ?: throw IllegalStateException("Node.js was not found. Configure a Node.js interpreter or add node to PATH.")
        val sidecar = SidecarProcess.start(node, script.toFile(), EnvironmentUtil.getEnvironmentMap(), LOG::warn) {
            LOG.info("sidecar: $it")
        }
        val scope = Disposer.newDisposable(this, "Packageawy sidecar")
        val host = IdeHostServices(project, scope) { message -> panel?.postMessage(message) }
        val handlers = ClientHandlers(
            sidecar.connection, host, workspaceState, GlobalState.getInstance().file,
            AppExecutorUtil.getAppExecutorService(), LOG::warn,
        )
        handlers.register()
        val current = Session(sidecar, handlers, host, scope)
        synchronized(lock) {
            current.pending.addAll(earlyMessages)
            earlyMessages.clear()
            session = current
        }
        sidecar.connection.onClose { onClosed(current) }
        subscribe(current)
        sidecar.connection.start()

        folders = workspaceFolders()
        val params = Initialize.params(
            folders,
            TrustedProjects.isProjectTrusted(project),
            PackageawySettings.getInstance().state.snapshot(),
            workspaceState.snapshot(),
            GlobalState.getInstance().file.snapshot(),
        )
        sidecar.connection.sendRequest("initialize", params).whenComplete { _, error ->
            if (error != null) {
                LOG.warn("initialize failed", error)
                notifyFailure("The Packageawy engine did not start: ${error.message}")
                return@whenComplete
            }
            val queued = synchronized(lock) {
                current.ready = true
                ArrayList(current.pending).also { current.pending.clear() }
            }
            for (message in queued) {
                sidecar.connection.sendNotification("webview/didReceiveMessage", mapOf("message" to message))
            }
        }
    }

    private fun subscribe(current: Session) {
        val connection = current.sidecar.connection
        val app = ApplicationManager.getApplication().messageBus.connect(current.scope)
        app.subscribe(SettingsListener.TOPIC, SettingsListener { state ->
            connection.sendNotification("settings/didChange", mapOf("settings" to state.snapshot()))
        })
        app.subscribe(TrustedProjectsListener.TOPIC, object : TrustedProjectsListener {
            override fun onProjectTrusted(project: Project) = trustChanged(project, true)
            override fun onProjectUntrusted(project: Project) = trustChanged(project, false)

            private fun trustChanged(changed: Project, trusted: Boolean) {
                if (changed == this@PackageawyProject.project) {
                    connection.sendNotification("workspace/didChangeTrust", mapOf("isWorkspaceTrusted" to trusted))
                }
            }
        })
        project.messageBus.connect(current.scope).subscribe(ModuleRootListener.TOPIC, object : ModuleRootListener {
            override fun rootsChanged(event: ModuleRootEvent) {
                ApplicationManager.getApplication().executeOnPooledThread {
                    val next = workspaceFolders()
                    if (next == folders) return@executeOnPooledThread
                    folders = next
                    connection.sendNotification("workspace/didChangeFolders", mapOf("workspaceFolders" to WorkspaceFolder.toJson(next)))
                }
            }
        })
    }

    private fun onClosed(closed: Session) {
        val wasCurrent = synchronized(lock) {
            if (session === closed) {
                session = null
                true
            } else {
                false
            }
        }
        cleanUp(closed)
        if (wasCurrent && !closed.stopping && !project.isDisposed) {
            notifyFailure("The Packageawy engine stopped.")
        }
    }

    private fun stopSidecar() {
        val current = synchronized(lock) {
            earlyMessages.clear()
            session.also { session = null }
        } ?: return
        current.stopping = true
        current.sidecar.connection.sendNotification("webview/didDispose", emptyMap<String, Any>())
        cleanUp(current)
        AppExecutorUtil.getAppExecutorService().execute { current.sidecar.close() }
    }

    private fun cleanUp(closed: Session) {
        closed.handlers.close()
        closed.host.endAllProgress()
        ApplicationManager.getApplication().invokeLater { Disposer.dispose(closed.scope) }
    }

    private fun notifyFailure(message: String) {
        NotificationGroupManager.getInstance().getNotificationGroup("Packageawy")
            .createNotification(message, NotificationType.ERROR)
            .addAction(NotificationAction.createSimpleExpiring("Restart") { restart() })
            .notify(project)
    }

    private fun workspaceFolders(): List<WorkspaceFolder> {
        val roots = ReadAction.computeBlocking<List<Path>, RuntimeException> {
            ProjectRootManager.getInstance(project).contentRoots
                .filter { it.isInLocalFileSystem }
                .map { it.toNioPath() }
        }
        val top = roots.filter { root -> roots.none { other -> other != root && root.startsWith(other) } }.distinct()
        val paths = top.ifEmpty { listOfNotNull(project.basePath?.let { Path.of(it) }) }
        return paths.map(WorkspaceFolder::of)
    }

    companion object {
        private val LOG = logger<PackageawyProject>()

        fun getInstance(project: Project): PackageawyProject = project.getService(PackageawyProject::class.java)

        private fun bundledSidecar(): Path? {
            val plugin = (PackageawyProject::class.java.classLoader as? PluginAwareClassLoader)?.pluginDescriptor ?: return null
            return plugin.pluginPath.resolve("sidecar").resolve("sidecar.js").takeIf { Files.isRegularFile(it) }
        }
    }
}
