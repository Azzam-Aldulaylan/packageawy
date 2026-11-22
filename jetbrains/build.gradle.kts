import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "io.github.azzamaldulaylan"
// The extension and the plugin always ship the same version. package.json is the only place it is set.
version = providers.fileContents(layout.projectDirectory.file("../package.json")).asText
    .map { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)?.groupValues?.get(1) ?: error("No version in package.json") }
    .get()

fun changelogHtml(markdown: String, version: String): String {
    val lines = markdown.lineSequence().toList()
    val heading = Regex("^## \\[${Regex.escape(version)}\\](?:\\s.*)?$")
    val start = lines.indexOfFirst { heading.matches(it) }
    if (start < 0) return ""

    fun inline(text: String): String = Regex("`([^`]+)`|\\*\\*(.+?)\\*\\*").let { markup ->
        fun escape(value: String) = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        buildString {
            var offset = 0
            markup.findAll(text).forEach { match ->
                append(escape(text.substring(offset, match.range.first)))
                if (match.groups[1] != null) {
                    append("<code>${escape(match.groupValues[1])}</code>")
                } else {
                    append("<b>${inline(match.groupValues[2])}</b>")
                }
                offset = match.range.last + 1
            }
            append(escape(text.substring(offset)))
        }
    }

    return buildString {
        var inList = false
        fun closeList() {
            if (inList) appendLine("</ul>")
            inList = false
        }
        for (line in lines.drop(start + 1).takeWhile { !it.startsWith("## ") }) {
            when {
                line.startsWith("- ") -> {
                    if (!inList) appendLine("<ul>")
                    inList = true
                    appendLine("<li>${inline(line.removePrefix("- "))}</li>")
                }
                line.isBlank() -> closeList()
                else -> {
                    closeList()
                    if (line.startsWith("### ")) appendLine("<h3>${inline(line.removePrefix("### "))}</h3>")
                    else appendLine("<p>${inline(line)}</p>")
                }
            }
        }
        closeList()
    }.trim()
}

val pluginChangeNotes = changelogHtml(
    providers.fileContents(layout.projectDirectory.file("../CHANGELOG.md")).asText.get(),
    project.version.toString(),
)

val checkChangeNotes = tasks.register("checkChangeNotes") {
    group = "verification"
    description = "Checks version selection and HTML formatting for plugin change notes."
    val markdown = """
        ## [Unreleased]
        - Next release.
        ## [0.9.7] - 2026-11-12
        ### Added
        - Use `package.json` and **Undo**.
        - Escape <tags> & `a < b && **literal**`.

        ### Changed
        - Keep **`code`**.
        ## [0.9.6] - 2026-11-11
        - Previous release.
    """.trimIndent()
    inputs.property("actual", changelogHtml(markdown, "0.9.7"))
    inputs.property("expected", """
        <h3>Added</h3>
        <ul>
        <li>Use <code>package.json</code> and <b>Undo</b>.</li>
        <li>Escape &lt;tags&gt; &amp; <code>a &lt; b &amp;&amp; **literal**</code>.</li>
        </ul>
        <h3>Changed</h3>
        <ul>
        <li>Keep <b><code>code</code></b>.</li>
        </ul>
    """.trimIndent())
    inputs.property("missing", changelogHtml(markdown, "1.0.0"))
    inputs.property("exactVersion", changelogHtml(markdown, "0.9"))
    inputs.property("endOfFile", changelogHtml("## [1.0.0]\r\n- Final item.", "1.0.0"))
    doLast {
        check(inputs.properties["actual"] == inputs.properties["expected"]) { "Plugin change notes must match the expected HTML." }
        check(inputs.properties["missing"] == "" && inputs.properties["exactVersion"] == "") { "Plugin change notes must use an exact version match." }
        check(inputs.properties["endOfFile"] == "<ul>\n<li>Final item.</li>\n</ul>") { "Plugin change notes must close the final list." }
    }
}

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(
            providers.gradleProperty("platformType"),
            providers.gradleProperty("platformVersion"),
        )
        bundledPlugin("JavaScript")
    }
    testImplementation("org.junit.jupiter:junit-jupiter:5.13.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // The platform test runtime still loads JUnit 4 classes.
    testRuntimeOnly("junit:junit:4.13.2")
}

intellijPlatform {
    projectName = "packageawy"
    pluginConfiguration {
        id = "io.github.azzamaldulaylan.packageawy"
        name = "Packageawy"
        version = project.version.toString()
        changeNotes = pluginChangeNotes
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            create(IntelliJPlatformType.WebStorm, providers.gradleProperty("platformVersion").get())
            create(IntelliJPlatformType.WebStorm, providers.gradleProperty("latestPlatformVersion").get())
        }
        failureLevel = listOf(
            VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
        )
    }
    // Set by the Release workflow. They are only read by signPlugin and publishPlugin,
    // so build, buildPlugin, runIde and verifyPlugin work without them.
    signing {
        certificateChain = providers.environmentVariable("JETBRAINS_CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("JETBRAINS_PRIVATE_KEY")
        password = providers.environmentVariable("JETBRAINS_PRIVATE_KEY_PASSWORD")
    }
    publishing {
        token = providers.environmentVariable("JETBRAINS_PUBLISH_TOKEN")
    }
}

// Runs the plugin in the newest stable WebStorm. Its bundled runtime brings JCEF.
intellijPlatformTesting.runIde.register("runIdeLatest") {
    type = IntelliJPlatformType.WebStorm
    version = providers.gradleProperty("latestPlatformVersion")
}

// The webview bundle and the sidecar come from the repository root build (`npm run build`).
// Pass -Ppackageawy.stubSidecar=true to bundle the test stub in place of dist/sidecar.js.
val rootDist = layout.projectDirectory.dir("../dist")
val stubSidecar = layout.projectDirectory.file("src/test/stub-sidecar/sidecar.js")
val useStubSidecar = providers.gradleProperty("packageawy.stubSidecar").map { it.toBoolean() }.orElse(false)

val checkBundledFiles = tasks.register("checkBundledFiles") {
    val required = listOf("webview.js", "webview.css", "ThirdPartyNotices.txt") + if (useStubSidecar.get()) emptyList() else listOf("sidecar.js")
    val files = required.map { rootDist.file(it).asFile }
    inputs.property("required", required)
    doLast {
        val missing = files.filterNot { it.isFile }
        if (missing.isNotEmpty()) {
            throw GradleException("Missing ${missing.joinToString { "dist/${it.name}" }}. Run `npm ci && npm run build` in the repository root first.")
        }
    }
}

// The publish job downloads an archive that has already passed build and verification.
// Override both inputs only in that path so signing never queries an excluded buildPlugin.
val publishArchive = providers.gradleProperty("packageawy.publishArchive")

tasks {
    if (publishArchive.isPresent) {
        signPlugin {
            val verifiedArchive = layout.projectDirectory.file(publishArchive.get())
            archiveFile.set(verifiedArchive)
            signedArchiveFile.set(layout.buildDirectory.file("distributions/${verifiedArchive.asFile.nameWithoutExtension}-signed.zip"))
        }
        publishPlugin {
            archiveFiles.setFrom(signPlugin.flatMap { it.signedArchiveFile })
        }
    }

    jar {
        from(rootDist) {
            include("webview.js", "webview.css", "ThirdPartyNotices.txt")
            into("packageawy")
        }
    }

    // The sidecar runs as a file, so it sits next to the plugin jars rather than inside one.
    withType<PrepareSandboxTask>().matching { !it.name.contains("Test") }.configureEach {
        dependsOn(checkBundledFiles)
        from(if (useStubSidecar.get()) stubSidecar else rootDist.file("sidecar.js")) {
            into("packageawy/sidecar")
        }
        // Include the project license and bundled JavaScript notices at the plugin's top level.
        from(listOf(layout.projectDirectory.file("../LICENSE"), rootDist.file("ThirdPartyNotices.txt"))) {
            into("packageawy")
        }
    }

    test {
        useJUnitPlatform()
        systemProperty("packageawy.stubSidecar", stubSidecar.asFile.absolutePath)
    }

    check {
        dependsOn(checkChangeNotes)
    }
}
