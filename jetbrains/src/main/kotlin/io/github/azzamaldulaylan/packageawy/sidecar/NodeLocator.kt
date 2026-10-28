package io.github.azzamaldulaylan.packageawy.sidecar

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import java.io.File

/** Supplies the Node.js interpreter configured in the IDE. Implemented when the NodeJS plugin is present. */
interface NodeInterpreterProvider {
    /** Absolute path of the configured local `node`, or null when none is configured. */
    fun nodePath(project: Project): String?

    companion object {
        val EP_NAME = ExtensionPointName.create<NodeInterpreterProvider>("io.github.azzamaldulaylan.packageawy.nodeInterpreterProvider")
    }
}

object NodeLocator {
    /** The IDE's configured interpreter first, then `node` on PATH. */
    fun find(project: Project): String? {
        for (provider in NodeInterpreterProvider.EP_NAME.extensionList) {
            val path = runCatching { provider.nodePath(project) }.getOrNull()
            if (path != null && File(path).canExecute()) return path
        }
        val name = if (SystemInfo.isWindows) "node.exe" else "node"
        return PathEnvironmentVariableUtil.findInPath(name)?.absolutePath
    }
}
