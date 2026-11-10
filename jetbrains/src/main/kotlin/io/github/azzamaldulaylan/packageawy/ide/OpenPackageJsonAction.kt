package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAwareAction

/** Which files "Open in Packageawy" applies to. The sidecar decides whether the file is a discovered project. */
object OpenManifest {
    const val UNAVAILABLE_MESSAGE = "Packageawy opens package.json files from your workspace folders, outside node_modules."

    fun isPackageJson(name: String): Boolean = name == "package.json"

    /** A package.json that is not inside node_modules. */
    fun isEligible(path: String): Boolean {
        val segments = path.replace('\\', '/').split('/')
        return isPackageJson(segments.last()) && "node_modules" !in segments
    }
}

/** Right-click a package.json to open its project in the Packageawy tool window. */
class OpenPackageJsonAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabledAndVisible = e.project != null && file != null && !file.isDirectory && OpenManifest.isPackageJson(file.name)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        if (!file.isInLocalFileSystem || !OpenManifest.isEligible(file.path)) {
            IdeHostServices.notify(project, OpenManifest.UNAVAILABLE_MESSAGE, NotificationType.INFORMATION)
            return
        }
        PackageawyProject.getInstance(project).openManifest(file.toNioPath().toString())
    }
}
