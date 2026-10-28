package io.github.azzamaldulaylan.packageawy.host

import com.google.gson.JsonElement
import com.google.gson.JsonPrimitive
import io.github.azzamaldulaylan.packageawy.ConnectedPair
import io.github.azzamaldulaylan.packageawy.rpc.ErrorCodes
import io.github.azzamaldulaylan.packageawy.rpc.ResponseError
import io.github.azzamaldulaylan.packageawy.storage.StateFile
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class ClientHandlersTest {
    @TempDir
    lateinit var dir: Path

    private val pair = ConnectedPair()
    private val host = FakeHost()
    private val executor = Executors.newCachedThreadPool()
    private lateinit var workspace: StateFile
    private lateinit var global: StateFile
    private lateinit var handlers: ClientHandlers
    private val sidecar get() = pair.b
    private val notifications = LinkedBlockingQueue<Pair<String, JsonElement?>>()

    @BeforeEach
    fun setUp() {
        workspace = StateFile(dir.resolve("workspace.json"))
        global = StateFile(dir.resolve("global.json"))
        handlers = ClientHandlers(pair.a, host, workspace, global, executor)
        handlers.register()
        for (method in listOf("files/didChange", "git/didChangeHead", "progress/cancel", "process/didExit")) {
            sidecar.onNotification(method) { notifications.add(method to it) }
        }
        pair.start()
    }

    @AfterEach
    fun tearDown() {
        handlers.close()
        pair.close()
        executor.shutdownNow()
    }

    private fun call(method: String, params: Any?): JsonElement? = sidecar.sendRequest(method, params).get(5, TimeUnit.SECONDS)

    private fun errorOf(method: String, params: Any?): Int {
        val error = runCatching { call(method, params) }.exceptionOrNull()
        return ((error as ExecutionException).cause as ResponseError).code
    }

    private fun nextEvent(): String = host.events.poll(5, TimeUnit.SECONDS) ?: error("No event")

    @Test
    fun `storage update writes the right scope and deletes on null`() {
        call("storage/update", mapOf("scope" to "workspace", "key" to "k", "value" to mapOf("a" to 1)))
        call("storage/update", mapOf("scope" to "global", "key" to "g", "value" to true))
        assertEquals(1, workspace.get("k")!!.asJsonObject["a"].asInt)
        assertEquals(JsonPrimitive(true), global.get("g"))
        call("storage/update", mapOf("scope" to "workspace", "key" to "k", "value" to null))
        assertNull(workspace.get("k"))
        assertEquals(ErrorCodes.INVALID_PARAMS, errorOf("storage/update", mapOf("scope" to "machine", "key" to "k")))
    }

    @Test
    fun `files find returns absolute paths`() {
        Files.writeString(dir.resolve("package.json"), "{}")
        val folder = mapOf("id" to dir.toUri().toString(), "name" to "x", "path" to dir.toString())
        val result = call("files/find", mapOf("folder" to folder, "dir" to "", "include" to "**/package.json", "exclude" to ""))!!
        assertEquals(listOf(dir.resolve("package.json").toString()), result.asJsonArray.map { it.asString })
    }

    @Test
    fun `relative paths are rejected`() {
        val folder = mapOf("id" to "x", "name" to "x", "path" to "relative/dir")
        assertEquals(
            ErrorCodes.INVALID_PARAMS,
            errorOf("files/find", mapOf("folder" to folder, "dir" to "", "include" to "**", "exclude" to "")),
        )
    }

    @Test
    fun `stat and read`() {
        val file = dir.resolve("a.txt")
        Files.writeString(file, "hello")
        assertEquals(5, call("files/stat", mapOf("path" to file.toString()))!!.asJsonObject["size"].asInt)
        val data = call("files/read", mapOf("path" to file.toString()))!!.asString
        assertEquals("hello", String(java.util.Base64.getDecoder().decode(data)))
    }

    @Test
    fun `file watch forwards changes with its id and unwatch disposes`() {
        call("files/watch", mapOf("watchId" to "w7", "baseDir" to dir.toString(), "glob" to "*.json"))
        assertEquals("watch:*.json", nextEvent())
        host.fileListeners.single().invoke("/x/package.json")
        val (method, params) = notifications.poll(5, TimeUnit.SECONDS)!!
        assertEquals("files/didChange", method)
        assertEquals("w7", params!!.asJsonObject["watchId"].asString)
        assertEquals("/x/package.json", params.asJsonObject["path"].asString)
        sidecar.sendNotification("files/unwatch", mapOf("watchId" to "w7"))
        assertEquals("unwatch:*.json", nextEvent())
    }

    @Test
    fun `integer ids are accepted and echoed as integers`() {
        call("files/watch", mapOf("watchId" to 12, "baseDir" to dir.toString(), "glob" to "*.json"))
        nextEvent()
        host.fileListeners.single().invoke("/x/a.json")
        val (_, params) = notifications.poll(5, TimeUnit.SECONDS)!!
        assertTrue(params!!.asJsonObject["watchId"].asJsonPrimitive.isNumber)
        assertEquals(12, params.asJsonObject["watchId"].asInt)
        sidecar.sendNotification("files/unwatch", mapOf("watchId" to 12))
        assertEquals("unwatch:*.json", nextEvent())
        sidecar.sendNotification("progress/start", mapOf("progressId" to 3, "title" to "Scan", "cancellable" to true))
        assertEquals("progress-start:3:Scan", nextEvent())
    }

    @Test
    fun `git head watch answers whether HEAD is observable`() {
        assertEquals(JsonPrimitive(true), call("git/watchHead", mapOf("watchId" to "g", "projectPath" to dir.toString())))
        host.hasRepository = false
        assertEquals(JsonPrimitive(false), call("git/watchHead", mapOf("watchId" to "h", "projectPath" to dir.toString())))
    }

    @Test
    fun `close disposes every watch`() {
        call("files/watch", mapOf("watchId" to "1", "baseDir" to dir.toString(), "glob" to "a"))
        call("files/watch", mapOf("watchId" to "2", "baseDir" to dir.toString(), "glob" to "b"))
        handlers.close()
        assertTrue(host.openWatches.isEmpty())
    }

    @Test
    fun `modal returns the chosen action or null`() {
        host.modalAnswer = "Upgrade"
        assertEquals("Upgrade", call("window/showModal", mapOf("message" to "Sure?", "detail" to "d", "actions" to listOf("Upgrade")))!!.asString)
        assertEquals("modal:Sure?:Upgrade", nextEvent())
        host.modalAnswer = null
        assertNull(call("window/showModal", mapOf("message" to "Sure?", "detail" to "", "actions" to listOf("Upgrade"))))
    }

    @Test
    fun `quick pick returns an index and drops out of range answers`() {
        val params = mapOf(
            "items" to listOf(mapOf("label" to "a"), mapOf("label" to "b", "description" to "second")),
            "options" to mapOf("title" to "Pick", "placeholder" to "", "matchOnDescription" to true, "matchOnDetail" to false),
        )
        host.pickAnswer = 1
        assertEquals(1, call("window/showQuickPick", params)!!.asInt)
        assertEquals("pick:a|b:Pick", nextEvent())
        host.pickAnswer = 7
        assertNull(call("window/showQuickPick", params))
    }

    @Test
    fun `cancelling a quick pick closes it and answers null`() {
        host.holdQuickPick = true
        val params = mapOf("items" to listOf(mapOf("label" to "a")), "options" to mapOf("title" to "", "placeholder" to ""))
        val future: CompletableFuture<JsonElement?> = sidecar.sendRequest("window/showQuickPick", params)
        nextEvent()
        sidecar.sendNotification("\$/cancelRequest", mapOf("id" to 1))
        assertEquals("pick-cancelled", nextEvent())
        assertNull(future.get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `process start reports the exit code`() {
        val java = ProcessHandle.current().info().command().orElseThrow()
        call(
            "process/start",
            mapOf(
                "processId" to "p1", "executable" to java, "args" to listOf("-version"), "cwd" to dir.toString(),
                "title" to "t", "scope" to "s",
            ),
        )
        val (method, params) = notifications.poll(30, TimeUnit.SECONDS)!!
        assertEquals("process/didExit", method)
        assertEquals("p1", params!!.asJsonObject["processId"].asString)
        assertEquals(0, params.asJsonObject["exitCode"].asInt)
    }

    @Test
    fun `process start failure is an error response`() {
        host.failProcessStart = true
        val params = mapOf("processId" to "p", "executable" to "x", "args" to listOf<String>(), "cwd" to dir.toString(), "title" to "t", "scope" to "s")
        assertEquals(ErrorCodes.INTERNAL_ERROR, errorOf("process/start", params))
    }

    @Test
    fun `notifications reach the host`() {
        sidecar.sendNotification("progress/start", mapOf("progressId" to "p", "title" to "Scanning"))
        sidecar.sendNotification("progress/report", mapOf("progressId" to "p", "message" to "half", "increment" to 50))
        sidecar.sendNotification("progress/end", mapOf("progressId" to "p"))
        sidecar.sendNotification("window/openFile", mapOf("path" to "/a/b.json", "position" to mapOf("line" to 3, "column" to 4)))
        sidecar.sendNotification("window/openSettings", mapOf("key" to "upgrade.ignoreScripts"))
        sidecar.sendNotification("webview/postMessage", mapOf("message" to mapOf("status" to "loading")))
        sidecar.sendNotification("webview/reveal", emptyMap<String, Any>())
        assertEquals("progress-start:p:Scanning", nextEvent())
        assertEquals("progress-report:p:half:50.0", nextEvent())
        assertEquals("progress-end:p", nextEvent())
        assertEquals("openFile:/a/b.json:3:4", nextEvent())
        assertEquals("openSettings:upgrade.ignoreScripts", nextEvent())
        assertEquals("""webview:{"status":"loading"}""", nextEvent())
        assertEquals("reveal", nextEvent())
    }

    @Test
    fun `messages map severities`() {
        sidecar.sendNotification("window/showMessage", mapOf("severity" to "warning", "message" to "careful"))
        sidecar.sendNotification("window/showMessage", mapOf("severity" to "loud", "message" to "ignored"))
        sidecar.sendNotification("window/showMessage", mapOf("severity" to "error", "message" to "bad"))
        assertEquals(Severity.WARNING to "careful", host.messages.poll(5, TimeUnit.SECONDS))
        assertEquals(Severity.ERROR to "bad", host.messages.poll(5, TimeUnit.SECONDS))
    }

    @Test
    fun `only web and mail links open externally`() {
        assertTrue(ClientHandlers.isAllowedExternalUrl("https://www.npmjs.com/package/react"))
        assertTrue(ClientHandlers.isAllowedExternalUrl("http://example.com"))
        assertFalse(ClientHandlers.isAllowedExternalUrl("file:///etc/passwd"))
        assertFalse(ClientHandlers.isAllowedExternalUrl("javascript:alert(1)"))
        assertFalse(ClientHandlers.isAllowedExternalUrl("not a url"))
        sidecar.sendNotification("window/openExternal", mapOf("url" to "file:///etc/passwd"))
        sidecar.sendNotification("window/openExternal", mapOf("url" to "https://example.com"))
        assertEquals("openExternal:https://example.com", nextEvent())
    }
}
