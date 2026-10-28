package io.github.azzamaldulaylan.packageawy.settings

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel

class PackageawyConfigurable : BoundConfigurable("Packageawy") {
    private val settings = PackageawySettings.getInstance()
    private var draft = settings.state.copy(verificationScripts = settings.state.verificationScripts.toMutableList())

    override fun createPanel(): DialogPanel = panel {
        group("Registry") {
            row {
                checkBox("Read the registry from the project's .npmrc")
                    .bindSelected(draft::useProjectNpmrc)
                    .comment("Values containing \${ are always rejected. Turn this off to use only your user-level .npmrc.")
            }
        }
        group("Upgrades") {
            row {
                checkBox("Pass --ignore-scripts when upgrading")
                    .bindSelected(draft::ignoreScripts)
                    .comment("Package lifecycle scripts don't run.")
            }
            row("Verification scripts:") {
                textField()
                    .align(AlignX.FILL)
                    .bindText(
                        { draft.verificationScripts.joinToString(", ") },
                        { text -> draft.verificationScripts = splitScripts(text) },
                    )
                    .comment("Comma-separated package.json script names to run after an install, for example test, build, typecheck. None run by default.")
            }
        }
        group("Cache") {
            row("Cache lifetime in minutes:") {
                intTextField(0..Int.MAX_VALUE)
                    .bindIntText(draft::cacheTtlMinutes)
                    .comment("How long cached dependency data stays fresh before it's rescanned. 0 means always revalidate.")
            }
        }
        group("Debug") {
            row {
                checkBox("Log performance measurements")
                    .bindSelected(draft::debugPerformance)
                    .comment("Written to the IDE log and the webview console. No telemetry is sent.")
            }
        }
    }

    override fun apply() {
        super.apply()
        settings.update(draft)
    }

    override fun reset() {
        draft.useProjectNpmrc = settings.state.useProjectNpmrc
        draft.ignoreScripts = settings.state.ignoreScripts
        draft.verificationScripts = settings.state.verificationScripts.toMutableList()
        draft.cacheTtlMinutes = settings.state.cacheTtlMinutes
        draft.debugPerformance = settings.state.debugPerformance
        super.reset()
    }

    companion object {
        fun splitScripts(text: String): MutableList<String> =
            text.split(',', '\n').map { it.trim() }.filter { it.isNotEmpty() }.distinct().toMutableList()
    }
}
