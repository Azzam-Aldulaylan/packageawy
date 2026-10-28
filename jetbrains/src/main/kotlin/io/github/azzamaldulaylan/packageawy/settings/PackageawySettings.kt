package io.github.azzamaldulaylan.packageawy.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.messages.Topic

/** The same settings as `contributes.configuration` in the VS Code extension's package.json. */
data class SettingsState(
    var useProjectNpmrc: Boolean = true,
    var ignoreScripts: Boolean = true,
    var verificationScripts: MutableList<String> = mutableListOf(),
    var cacheTtlMinutes: Int = 30,
    var debugPerformance: Boolean = false,
) {
    /** Keys relative to the `packageawy` section, as the sidecar reads them. */
    fun snapshot(): Map<String, Any> = linkedMapOf(
        "registry.useProjectNpmrc" to useProjectNpmrc,
        "upgrade.ignoreScripts" to ignoreScripts,
        "upgrade.verificationScripts" to verificationScripts.map { it.trim() }.filter { it.isNotEmpty() },
        "cacheTtlMinutes" to cacheTtlMinutes.coerceAtLeast(0),
        "debug.performance" to debugPerformance,
    )
}

fun interface SettingsListener {
    fun settingsChanged(state: SettingsState)

    companion object {
        @Topic.AppLevel
        val TOPIC = Topic.create("Packageawy settings", SettingsListener::class.java)
    }
}

@Service(Service.Level.APP)
@State(name = "PackageawySettings", storages = [Storage("packageawy.xml")])
class PackageawySettings : PersistentStateComponent<SettingsState> {
    private var state = SettingsState()

    override fun getState(): SettingsState = state

    override fun loadState(loaded: SettingsState) {
        state = loaded
    }

    fun update(next: SettingsState) {
        state = next.copy(verificationScripts = next.verificationScripts.toMutableList())
        ApplicationManager.getApplication().messageBus.syncPublisher(SettingsListener.TOPIC).settingsChanged(state)
    }

    companion object {
        fun getInstance(): PackageawySettings = ApplicationManager.getApplication().getService(PackageawySettings::class.java)
    }
}
