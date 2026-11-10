package io.github.azzamaldulaylan.packageawy.settings

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.Cell
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.selected
import javax.swing.JCheckBox

/** Shows and edits this project's settings: the advisory check and its override of the verification scripts. */
class PackageawyProjectConfigurable(project: Project) : BoundConfigurable("Project") {
    private val settings = PackageawyProjectSettings.getInstance(project)
    private var draft = settings.state.copy(verificationScripts = settings.state.verificationScripts.toMutableList())

    override fun createPanel(): DialogPanel = panel {
        group("Security") {
            row {
                checkBox("Check dependencies for known vulnerabilities")
                    .bindSelected(draft::publicAdvisoryCheck)
                    .comment(
                        "Each scan sends the name and installed version of every package in the dependency tree, " +
                            "including private packages, to npm's public advisory service at registry.npmjs.org, " +
                            "sends affected package names to api.github.com for CVE and GHSA identifiers, and runs npm audit. " +
                            "Turn this off to skip these requests for this project.",
                    )
            }
        }
        group("Verification") {
            lateinit var override: Cell<JCheckBox>
            row {
                override = checkBox("Use project-specific verification scripts")
                    .bindSelected(draft::overrideVerificationScripts)
                    .comment("Set by Remember for this project in the Verification card. Clear it to use the IDE-wide list.")
            }
            row("Scripts:") {
                textField()
                    .align(AlignX.FILL)
                    .bindText(
                        { draft.verificationScripts.joinToString(", ") },
                        { text -> draft.verificationScripts = PackageawyConfigurable.splitScripts(text) },
                    )
                    .comment("Comma-separated package.json script names.")
            }.enabledIf(override.selected)
        }
    }

    override fun apply() {
        super.apply()
        settings.update(draft)
    }

    override fun reset() {
        draft.overrideVerificationScripts = settings.state.overrideVerificationScripts
        draft.verificationScripts = settings.state.verificationScripts.toMutableList()
        draft.publicAdvisoryCheck = settings.state.publicAdvisoryCheck
        super.reset()
    }
}
