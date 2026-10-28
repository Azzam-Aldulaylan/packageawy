import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "io.github.azzamaldulaylan"
version = providers.gradleProperty("pluginVersion").get()

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
    val required = listOf("webview.js", "webview.css") + if (useStubSidecar.get()) emptyList() else listOf("sidecar.js")
    val files = required.map { rootDist.file(it).asFile }
    inputs.property("required", required)
    doLast {
        val missing = files.filterNot { it.isFile }
        if (missing.isNotEmpty()) {
            throw GradleException("Missing ${missing.joinToString { "dist/${it.name}" }}. Run `npm ci && npm run build` in the repository root first.")
        }
    }
}

tasks {
    jar {
        from(rootDist) {
            include("webview.js", "webview.css")
            into("packageawy")
        }
    }

    // The sidecar runs as a file, so it sits next to the plugin jars rather than inside one.
    withType<PrepareSandboxTask>().matching { !it.name.contains("Test") }.configureEach {
        dependsOn(checkBundledFiles)
        from(if (useStubSidecar.get()) stubSidecar else rootDist.file("sidecar.js")) {
            into("packageawy/sidecar")
        }
    }

    test {
        useJUnitPlatform()
        systemProperty("packageawy.stubSidecar", stubSidecar.asFile.absolutePath)
    }
}
