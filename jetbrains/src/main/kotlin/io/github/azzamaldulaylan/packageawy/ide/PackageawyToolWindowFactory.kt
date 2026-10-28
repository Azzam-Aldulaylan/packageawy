package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class PackageawyToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = PackageawyProject.getInstance(project)
        val scope = Disposer.newDisposable(toolWindow.disposable, "Packageawy webview")
        val content = ContentFactory.getInstance().createContent(service.createComponent(scope), "", false)
        content.setDisposer(scope)
        toolWindow.contentManager.addContent(content)
        toolWindow.setTitleActions(listOf(RefreshAction(), RestartAction()))
        toolWindow.setAdditionalGearActions(DefaultActionGroup(DevToolsAction()))
    }

    private class RefreshAction : DumbAwareAction("Refresh", "Rescan the project", AllIcons.Actions.Refresh) {
        override fun actionPerformed(e: AnActionEvent) {
            e.project?.let { PackageawyProject.getInstance(it).refresh() }
        }
    }

    private class RestartAction : DumbAwareAction("Restart Packageawy", "Restart the engine and reload the dashboard", AllIcons.Actions.Restart) {
        override fun actionPerformed(e: AnActionEvent) {
            e.project?.let { PackageawyProject.getInstance(it).restart() }
        }
    }

    private class DevToolsAction : DumbAwareAction("Open Webview DevTools") {
        override fun actionPerformed(e: AnActionEvent) {
            e.project?.let { PackageawyProject.getInstance(it).openDevTools() }
        }
    }
}
