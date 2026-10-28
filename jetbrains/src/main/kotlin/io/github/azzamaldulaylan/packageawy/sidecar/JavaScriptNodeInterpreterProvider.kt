package io.github.azzamaldulaylan.packageawy.sidecar

import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.openapi.project.Project

/** The project's Node.js interpreter from the JavaScript plugin. Registered only when that plugin is present. */
class JavaScriptNodeInterpreterProvider : NodeInterpreterProvider {
    override fun nodePath(project: Project): String? {
        val interpreter = NodeJsInterpreterManager.getInstance(project).interpreter as? NodeJsLocalInterpreter ?: return null
        return interpreter.interpreterSystemDependentPath
    }
}
