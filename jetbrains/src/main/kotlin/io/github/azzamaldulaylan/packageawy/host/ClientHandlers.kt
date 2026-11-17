package io.github.azzamaldulaylan.packageawy.host

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import io.github.azzamaldulaylan.packageawy.files.FileFinder
import io.github.azzamaldulaylan.packageawy.rpc.ErrorCodes
import io.github.azzamaldulaylan.packageawy.rpc.JsonRpcConnection
import io.github.azzamaldulaylan.packageawy.rpc.Params
import io.github.azzamaldulaylan.packageawy.rpc.ResponseError
import io.github.azzamaldulaylan.packageawy.settings.VerificationScriptNames
import io.github.azzamaldulaylan.packageawy.storage.StateFile
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor

/**
 * Registers every client side handler of the protocol in hostPlatform.ts on
 * a connection. Decodes and validates params, then calls [HostServices].
 */
class ClientHandlers(
    private val connection: JsonRpcConnection,
    private val host: HostServices,
    private val workspaceState: StateFile,
    private val globalState: StateFile,
    private val background: Executor,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
) : AutoCloseable {
    private val fileWatches = ConcurrentHashMap<String, AutoCloseable>()
    private val headWatches = ConcurrentHashMap<String, AutoCloseable>()
    private val processes = ConcurrentHashMap<Long, ProcessStop>()
    private val successfulProcesses = ConcurrentHashMap<Long, ProcessStop>()

    internal val retainedProcessCount: Int get() = successfulProcesses.size

    // Exit or cancellation may arrive before startProcess returns. Preserve that state until the handle is attached.
    private class ProcessStop(private val onRelease: () -> Unit) : AutoCloseable {
        private var requested = false
        private var successRequested = false
        private var completed = false
        private var successful = false
        private var handle: AutoCloseable? = null
        private var disposalWatch: AutoCloseable? = null
        @Volatile var released = false
            private set
        val cancelled: Boolean @Synchronized get() = requested

        @Synchronized fun attach(stop: AutoCloseable) {
            handle = stop
            if (requested) handle.also { handle = null }?.close()
            else if (successRequested) (handle.also { handle = null } as? SuccessfulProcess)?.closeAfterSuccess()
            else if (completed && released) handle = null
            else if (!released && stop is SuccessfulProcess) {
                val watch = stop.onConsoleDisposed { release() }
                if (released) watch.close() else disposalWatch = watch
            }
        }

        @Synchronized fun exited(exitCode: Int?) {
            completed = true
            successful = exitCode == 0
            if (released) handle = null
        }

        @Synchronized fun release() {
            released = true
            if (completed) handle = null
            disposalWatch?.close()
            disposalWatch = null
            onRelease()
        }

        @Synchronized fun reveal(): CompletableFuture<Boolean> =
            if (released || requested) CompletableFuture.completedFuture(false)
            else (handle as? SuccessfulProcess)?.reveal() ?: CompletableFuture.completedFuture(false)

        @Synchronized fun closeAfterSuccess() {
            if (!successful) return
            successRequested = true
            disposalWatch?.close()
            disposalWatch = null
            if (!requested && !released) (handle.also { handle = null } as? SuccessfulProcess)?.closeAfterSuccess()
        }

        @Synchronized override fun close() {
            requested = true
            disposalWatch?.close()
            disposalWatch = null
            handle.also { handle = null }?.close()
        }
    }

    private fun Params.processId(): Long {
        val value = raw("processId")
        if (value == null || !value.isJsonPrimitive || !value.asJsonPrimitive.isNumber) Params.invalid("processId must be a safe positive integer")
        val id = runCatching { value.asBigDecimal.toBigIntegerExact().longValueExact() }.getOrNull()
            ?: Params.invalid("processId must be a safe positive integer")
        if (id <= 0 || id > 9007199254740991L) Params.invalid("processId must be a safe positive integer")
        return id
    }

    fun register() {
        request("storage/update") { p ->
            val store = when (val scope = p.string("scope")) {
                "workspace" -> workspaceState
                "global" -> globalState
                else -> Params.invalid("Unknown storage scope $scope")
            }
            store.update(p.string("key"), p.raw("value"))
            null
        }

        request("settings/update") { p ->
            val key = p.string("key")
            // The sidecar only ever writes the verification scripts it validated against its own suggestions.
            if (key != VERIFICATION_SCRIPTS_KEY) Params.invalid("Setting $key cannot be changed by the engine")
            val names = p.stringList("value")
            if (!VerificationScriptNames.isValid(names)) Params.invalid("Invalid verification script names")
            try {
                host.rememberVerificationScripts(names)
            } catch (e: ResponseError) {
                throw e
            } catch (e: Exception) {
                throw ResponseError(ErrorCodes.INTERNAL_ERROR, e.message ?: "Could not save the setting")
            }
            null
        }

        connection.onRequest("files/find") { params, cancel ->
            val p = Params.of(params)
            val folder = p.obj("folder")
            val folderPath = absolutePath(folder.string("path"))
            val dir = p.string("dir")
            val include = p.string("include")
            val exclude = p.optString("exclude") ?: ""
            val maxResults = p.optInt("maxResults")
            CompletableFuture.supplyAsync({
                val found = FileFinder.find(folderPath, dir, include, exclude, maxResults) { cancel.isCancelled }
                JsonRpcConnection.toJson(found)
            }, background)
        }

        connection.onRequest("files/stat") { params, _ ->
            val path = absolutePath(Params.of(params).string("path"))
            CompletableFuture.supplyAsync({
                val result = JsonObject()
                result.addProperty("size", Files.size(path))
                result as JsonElement
            }, background)
        }

        connection.onRequest("files/read") { params, _ ->
            val path = absolutePath(Params.of(params).string("path"))
            CompletableFuture.supplyAsync({
                JsonPrimitive(Base64.getEncoder().encodeToString(Files.readAllBytes(path))) as JsonElement
            }, background)
        }

        request("files/watch") { p ->
            val watchId = p.id("watchId")
            val baseDir = absolutePath(p.string("baseDir")).toString()
            val glob = p.string("glob")
            val watch = host.watchFiles(baseDir, glob) { path ->
                connection.sendNotification("files/didChange", mapOf("watchId" to watchId, "path" to path))
            }
            fileWatches.put(key(watchId), watch)?.close()
            null
        }

        notification("files/unwatch") { p -> fileWatches.remove(key(p.id("watchId")))?.close() }

        request("git/watchHead") { p ->
            val watchId = p.id("watchId")
            val projectPath = absolutePath(p.string("projectPath")).toString()
            val watch = host.watchGitHead(projectPath) {
                connection.sendNotification("git/didChangeHead", mapOf("watchId" to watchId))
            }
            if (watch != null) headWatches.put(key(watchId), watch)?.close()
            JsonPrimitive(watch != null)
        }

        notification("git/unwatchHead") { p -> headWatches.remove(key(p.id("watchId")))?.close() }

        notification("progress/start") { p ->
            val id = p.id("progressId")
            host.startProgress(key(id), p.string("title")) {
                connection.sendNotification("progress/cancel", mapOf("progressId" to id))
            }
        }
        notification("progress/report") { p ->
            host.reportProgress(key(p.id("progressId")), p.optString("message"), p.optDouble("increment"))
        }
        notification("progress/end") { p -> host.endProgress(key(p.id("progressId"))) }

        notification("window/showMessage") { p ->
            val severity = when (val value = p.string("severity")) {
                "info" -> Severity.INFO
                "warning" -> Severity.WARNING
                "error" -> Severity.ERROR
                else -> Params.invalid("Unknown severity $value")
            }
            host.showMessage(severity, p.string("message"))
        }

        connection.onRequest("window/showModal") { params, _ ->
            val p = Params.of(params)
            host.showModal(p.string("message"), p.optString("detail") ?: "", p.stringList("actions"))
                .thenApply { choice -> choice?.let(::JsonPrimitive) }
        }

        connection.onRequest("window/showQuickPick") { params, cancel ->
            val p = Params.of(params)
            val items = p.objectList("items").map {
                QuickPickEntry(it.string("label"), it.optString("description"), it.optString("detail"))
            }
            val options = p.obj("options")
            val settings = QuickPickSettings(
                title = options.optString("title") ?: "",
                placeholder = options.optString("placeholder") ?: "",
                matchOnDescription = options.optBool("matchOnDescription"),
                matchOnDetail = options.optBool("matchOnDetail"),
            )
            host.showQuickPick(items, settings, cancel).thenApply { index ->
                index?.takeIf { it in items.indices }?.let(::JsonPrimitive)
            }
        }

        request("process/start") { p ->
            val processId = p.processId()
            val start = ProcessStart(
                executable = p.string("executable"),
                args = p.stringList("args"),
                cwd = absolutePath(p.string("cwd")).toString(),
                title = p.string("title"),
                scope = p.string("scope"),
            )
            lateinit var slot: ProcessStop
            slot = ProcessStop { successfulProcesses.remove(processId, slot) }
            // Reserve before launch so a duplicate can never replace a live stop handle.
            if (processes.putIfAbsent(processId, slot) != null) Params.invalid("processId is already active")
            successfulProcesses.remove(processId)?.release()
            try {
                val stop = host.startProcess(start) { exitCode ->
                    slot.exited(exitCode)
                    if (exitCode != null && !slot.cancelled && !slot.released) {
                        successfulProcesses[processId] = slot
                        // Disposal or settlement can race the exit notification.
                        if (slot.released) successfulProcesses.remove(processId, slot)
                    } else slot.release()
                    // Keep the active entry reachable until completed ownership is published.
                    processes.remove(processId, slot)
                    connection.sendNotification("process/didExit", mapOf("processId" to processId, "exitCode" to exitCode))
                }
                slot.attach(stop)
            } catch (e: Exception) {
                processes.remove(processId, slot)
                throw ResponseError(ErrorCodes.INTERNAL_ERROR, e.message ?: "Could not start ${start.executable}")
            }
            null
        }

        notification("process/terminate") { p ->
            val id = p.processId()
            successfulProcesses.remove(id)?.release()
            processes.remove(id)?.close()
        }

        notification("process/release") { p ->
            val id = p.processId()
            (successfulProcesses.remove(id) ?: processes[id])?.release()
        }

        connection.onRequest("process/reveal") { params, _ ->
            try {
                val id = Params.of(params).processId()
                (successfulProcesses[id] ?: processes[id])?.reveal()?.thenApply { JsonPrimitive(it) }
                    ?: CompletableFuture.completedFuture(JsonPrimitive(false))
            } catch (e: Exception) { CompletableFuture.failedFuture(e) }
        }

        notification("process/succeeded") { p ->
            successfulProcesses.remove(p.processId())?.closeAfterSuccess()
        }

        notification("window/openFile") { p ->
            val position = p.optObj("position")
            host.openFile(absolutePath(p.string("path")).toString(), position?.optInt("line"), position?.optInt("column"))
        }

        notification("window/openExternal") { p ->
            val url = p.string("url")
            if (isAllowedExternalUrl(url)) host.openExternal(url) else log("Refused to open $url", null)
        }

        notification("window/openSettings") { p -> host.openSettings(p.string("key")) }

        connection.onNotification("webview/postMessage") { params ->
            val message = Params.of(params).raw("message") ?: return@onNotification
            host.postToWebview(message)
        }

        connection.onNotification("webview/reveal") { _ -> host.revealWebview() }
    }

    override fun close() {
        for (watch in fileWatches.values + headWatches.values) runCatching { watch.close() }
        fileWatches.clear()
        headWatches.clear()
        for (slot in processes.values + successfulProcesses.values) slot.release()
        processes.clear()
        successfulProcesses.clear()
    }

    private fun request(method: String, handle: (Params) -> JsonElement?) {
        connection.onRequest(method) { params, _ ->
            try {
                CompletableFuture.completedFuture(handle(Params.of(params)))
            } catch (e: Exception) {
                CompletableFuture.failedFuture(e)
            }
        }
    }

    private fun notification(method: String, handle: (Params) -> Unit) {
        connection.onNotification(method) { params ->
            try {
                handle(Params.of(params))
            } catch (e: ResponseError) {
                log("Ignored $method: ${e.message}", null)
            }
        }
    }

    private fun key(id: JsonPrimitive): String = if (id.isNumber) id.asNumber.toLong().toString() else id.asString

    private fun Params.optBool(name: String): Boolean = raw(name)?.let { it.isJsonPrimitive && it.asBoolean } ?: false

    companion object {
        private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto")
        const val VERIFICATION_SCRIPTS_KEY = "upgrade.verificationScripts"

        fun isAllowedExternalUrl(url: String): Boolean {
            val scheme = runCatching { URI(url).scheme }.getOrNull()?.lowercase() ?: return false
            return scheme in EXTERNAL_SCHEMES
        }

        fun absolutePath(value: String): Path {
            val path = runCatching { Path.of(value) }.getOrNull() ?: Params.invalid("Invalid path $value")
            if (!path.isAbsolute) Params.invalid("Path must be absolute: $value")
            return path.normalize()
        }
    }
}
