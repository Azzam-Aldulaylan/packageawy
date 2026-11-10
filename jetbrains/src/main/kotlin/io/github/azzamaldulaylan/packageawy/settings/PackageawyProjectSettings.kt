package io.github.azzamaldulaylan.packageawy.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.project.Project
import com.intellij.util.messages.Topic

/**
 * Project-level values. The verification script list overrides
 * [SettingsState], the same value VS Code keeps in the workspace's settings.
 * The public advisory check is set per project, like VS Code's
 * resource-scoped `security.publicAdvisoryCheck`.
 */
data class ProjectSettingsState(
    var overrideVerificationScripts: Boolean = false,
    var verificationScripts: MutableList<String> = mutableListOf(),
    var publicAdvisoryCheck: Boolean = true,
) {
    /** The override to apply, or null when this project uses the IDE-wide value. */
    fun verificationScriptsOverride(): List<String>? = if (overrideVerificationScripts) verificationScripts.toList() else null
}

fun interface ProjectSettingsListener {
    fun projectSettingsChanged(state: ProjectSettingsState)

    companion object {
        @Topic.ProjectLevel
        val TOPIC = Topic.create("Packageawy project settings", ProjectSettingsListener::class.java)
    }
}

/** Script names the sidecar may store for a project. Mirrors SAFE_SCRIPT_NAME in src/core/upgrade/verificationSuggestions.ts. */
object VerificationScriptNames {
    const val MAX_NAMES = 8
    private val SAFE_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$")

    fun isValid(names: List<String>): Boolean =
        names.size <= MAX_NAMES && names.distinct().size == names.size && names.all(SAFE_NAME::matches)
}

@Service(Service.Level.PROJECT)
@State(name = "PackageawyProjectSettings", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class PackageawyProjectSettings(private val project: Project) : PersistentStateComponent<ProjectSettingsState> {
    private var state = ProjectSettingsState()

    override fun getState(): ProjectSettingsState = state

    override fun loadState(loaded: ProjectSettingsState) {
        state = loaded
    }

    fun update(next: ProjectSettingsState) {
        state = next.copy(verificationScripts = next.verificationScripts.toMutableList())
        project.messageBus.syncPublisher(ProjectSettingsListener.TOPIC).projectSettingsChanged(state)
    }

    /** Stores [names] as this project's verification scripts. Callers validate them first. */
    fun rememberVerificationScripts(names: List<String>) {
        require(VerificationScriptNames.isValid(names)) { "Invalid verification script names" }
        update(state.copy(overrideVerificationScripts = true, verificationScripts = names.toMutableList()))
    }

    companion object {
        fun getInstance(project: Project): PackageawyProjectSettings = project.getService(PackageawyProjectSettings::class.java)
    }
}
