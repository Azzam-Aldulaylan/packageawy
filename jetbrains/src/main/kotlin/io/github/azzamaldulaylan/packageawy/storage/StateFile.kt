package io.github.azzamaldulaylan.packageawy.storage

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.github.azzamaldulaylan.packageawy.rpc.JsonRpcConnection
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * One storage scope (workspace or global) kept as a JSON object in a file.
 * Updates apply in memory at once and reach disk after a short delay, or
 * right away when no scheduler is given.
 */
class StateFile(
    private val path: Path,
    private val scheduler: ScheduledExecutorService? = null,
    private val flushDelayMs: Long = 500,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
) {
    private val lock = Any()
    private val values: JsonObject = load()
    private var pendingFlush: ScheduledFuture<*>? = null

    fun snapshot(): JsonObject = synchronized(lock) { values.deepCopy() }

    fun get(key: String): JsonElement? = synchronized(lock) { values.get(key)?.deepCopy() }

    /** A null value removes the key. */
    fun update(key: String, value: JsonElement?) {
        synchronized(lock) {
            if (value == null || value.isJsonNull) values.remove(key) else values.add(key, value.deepCopy())
            if (scheduler == null) {
                writeLocked()
            } else if (pendingFlush == null) {
                pendingFlush = scheduler.schedule({ flush() }, flushDelayMs, TimeUnit.MILLISECONDS)
            }
        }
    }

    fun flush() {
        synchronized(lock) {
            pendingFlush?.cancel(false)
            pendingFlush = null
            writeLocked()
        }
    }

    private fun writeLocked() {
        try {
            Files.createDirectories(path.parent)
            val temp = Files.createTempFile(path.parent, path.fileName.toString(), ".tmp")
            Files.writeString(temp, JsonRpcConnection.GSON.toJson(values))
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: Exception) {
            log("Could not write $path", e)
        }
    }

    private fun load(): JsonObject {
        if (!Files.isRegularFile(path)) return JsonObject()
        return try {
            JsonParser.parseString(Files.readString(path)).takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
        } catch (e: Exception) {
            log("Ignoring unreadable state file $path", e)
            JsonObject()
        }
    }
}
