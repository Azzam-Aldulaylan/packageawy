package io.github.azzamaldulaylan.packageawy.sidecar

import com.google.gson.JsonObject
import io.github.azzamaldulaylan.packageawy.host.ClientHandlers
import io.github.azzamaldulaylan.packageawy.host.FakeHost
import io.github.azzamaldulaylan.packageawy.host.Severity
import io.github.azzamaldulaylan.packageawy.storage.StateFile
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Runs the stub sidecar under node and drives the real client handlers against it. */
class StubSidecarTest {
    @TempDir
    lateinit var dir: Path

    private val executor = Executors.newCachedThreadPool()
    private var sidecar: SidecarProcess? = null

    @AfterEach
    fun tearDown() {
        sidecar?.close()
        executor.shutdownNow()
    }

    private fun node(): String? = System.getenv("PATH").orEmpty().split(File.pathSeparator)
        .flatMap { listOf(File(it, "node"), File(it, "node.exe")) }
        .firstOrNull { it.canExecute() }?.absolutePath

    private fun start(host: FakeHost, workspace: StateFile, global: StateFile): SidecarProcess {
        val node = node()
        assumeTrue(node != null, "node is not on PATH")
        val script = File(System.getProperty("packageawy.stubSidecar"))
        val process = SidecarProcess.start(node!!, script, mapOf("PACKAGEAWY_STUB_SELF_TEST" to "1"), { _, _ -> }) {}
        sidecar = process
        ClientHandlers(process.connection, host, workspace, global, executor).register()
        process.connection.start()
        return process
    }

    @Test
    fun `stub exercises every client handler`() {
        Files.writeString(dir.resolve("package.json"), "{}")
        val host = FakeHost().apply {
            modalAnswer = "Yes"
            pickAnswer = 1
            hasRepository = false
        }
        val workspace = StateFile(dir.resolve("state/workspace.json"))
        val global = StateFile(dir.resolve("state/global.json"))
        val process = start(host, workspace, global)

        val params = Initialize.params(
            listOf(WorkspaceFolder.of(dir)), true, mapOf("upgrade.ignoreScripts" to true), JsonObject(), JsonObject(),
        )
        process.connection.sendRequest("initialize", params).get(10, TimeUnit.SECONDS)

        val (severity, message) = host.messages.poll(30, TimeUnit.SECONDS) ?: error("No self-test report")
        assertEquals(Severity.INFO, severity)
        assertEquals("self-test find:1 storage head:false modal:Yes pick:1 exit:3", message)
        assertTrue(workspace.get("stub.workspace")!!.asJsonObject["ok"].asBoolean)
        assertEquals(1, global.get("stub.global")!!.asInt)

        val events = generateSequence { host.events.poll() }.toList()
        assertTrue(events.contains("progress-start:1:Stub progress"), events.toString())
        assertTrue(events.contains("openFile:${dir.resolve("package.json")}:1:1"), events.toString())
        assertTrue(events.contains("openExternal:https://example.com"), events.toString())
        assertTrue(events.contains("openSettings:upgrade.ignoreScripts"), events.toString())
        assertTrue(events.contains("reveal"), events.toString())
        assertTrue(events.contains("unwatch:**/package.json"), events.toString())
    }

    @Test
    fun `webview messages are relayed both ways`() {
        val host = FakeHost()
        val process = start(host, StateFile(dir.resolve("w.json")), StateFile(dir.resolve("g.json")))
        val params = Initialize.params(listOf(WorkspaceFolder.of(dir)), true, emptyMap(), JsonObject(), JsonObject())
        process.connection.sendRequest("initialize", params).get(10, TimeUnit.SECONDS)
        process.connection.sendNotification("webview/didReceiveMessage", mapOf("message" to mapOf("type" to "ready")))
        val deadline = System.currentTimeMillis() + 10_000
        while (host.webview.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals("fatal-error", host.webview.single().asJsonObject["status"].asString)
    }

    @Test
    fun `workspace folder ids are stable file uris`() {
        val folder = WorkspaceFolder.of(dir)
        assertEquals(dir.toUri().toString().removeSuffix("/"), folder.id)
        assertEquals(folder, WorkspaceFolder.of(dir.resolve("x/..")))
        assertEquals(dir.fileName.toString(), folder.name)
    }
}
