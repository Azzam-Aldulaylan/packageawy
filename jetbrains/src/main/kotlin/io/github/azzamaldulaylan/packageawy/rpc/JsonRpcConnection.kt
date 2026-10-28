package io.github.azzamaldulaylan.packageawy.rpc

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

object ErrorCodes {
    const val PARSE_ERROR = -32700
    const val INVALID_REQUEST = -32600
    const val METHOD_NOT_FOUND = -32601
    const val INVALID_PARAMS = -32602
    const val INTERNAL_ERROR = -32603
    const val REQUEST_CANCELLED = -32800
}

class ResponseError(val code: Int, message: String) : RuntimeException(message)

/** Set when the peer sends `$/cancelRequest` for the request being handled. */
class CancelSignal {
    private val cancelled = AtomicBoolean(false)
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    val isCancelled: Boolean get() = cancelled.get()

    fun onCancel(listener: () -> Unit) {
        listeners.add(listener)
        if (cancelled.get() && listeners.remove(listener)) listener()
    }

    fun cancel() {
        if (!cancelled.compareAndSet(false, true)) return
        for (listener in listeners) if (listeners.remove(listener)) listener()
    }
}

typealias RequestHandler = (params: JsonElement?, cancel: CancelSignal) -> CompletableFuture<JsonElement?>
typealias NotificationHandler = (params: JsonElement?) -> Unit

/**
 * JSON-RPC 2.0 over a pair of streams. Incoming messages are dispatched in
 * order on the reader thread, so handlers must not block. Request handlers
 * return a future and move slow work elsewhere.
 */
class JsonRpcConnection(
    input: InputStream,
    output: OutputStream,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
) : AutoCloseable {
    private val reader = MessageReader(input)
    private val writer = MessageWriter(output)
    private val requestHandlers = ConcurrentHashMap<String, RequestHandler>()
    private val notificationHandlers = ConcurrentHashMap<String, NotificationHandler>()
    private val pending = ConcurrentHashMap<String, CompletableFuture<JsonElement?>>()
    private val incoming = ConcurrentHashMap<String, CancelSignal>()
    private val nextId = AtomicLong(1)
    private val closed = AtomicBoolean(false)
    private val closeListeners = CopyOnWriteArrayList<() -> Unit>()
    private var thread: Thread? = null

    fun onRequest(method: String, handler: RequestHandler) {
        requestHandlers[method] = handler
    }

    fun onNotification(method: String, handler: NotificationHandler) {
        notificationHandlers[method] = handler
    }

    fun onClose(listener: () -> Unit) {
        closeListeners.add(listener)
    }

    val isClosed: Boolean get() = closed.get()

    fun start(name: String = "Packageawy JSON-RPC") {
        val t = Thread({ readLoop() }, name)
        t.isDaemon = true
        thread = t
        t.start()
    }

    fun sendRequest(method: String, params: Any?): CompletableFuture<JsonElement?> {
        val future = CompletableFuture<JsonElement?>()
        if (closed.get()) {
            future.completeExceptionally(IllegalStateException("Connection is closed"))
            return future
        }
        val id = nextId.getAndIncrement()
        pending[id.toString()] = future
        val message = JsonObject()
        message.addProperty("jsonrpc", "2.0")
        message.addProperty("id", id)
        message.addProperty("method", method)
        if (params != null) message.add("params", toJson(params))
        if (!send(message)) {
            pending.remove(id.toString())
            future.completeExceptionally(IllegalStateException("Connection is closed"))
        }
        return future
    }

    fun sendNotification(method: String, params: Any?) {
        val message = JsonObject()
        message.addProperty("jsonrpc", "2.0")
        message.addProperty("method", method)
        if (params != null) message.add("params", toJson(params))
        send(message)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        for (future in pending.values) future.completeExceptionally(IllegalStateException("Connection closed"))
        pending.clear()
        for (signal in incoming.values) signal.cancel()
        incoming.clear()
        for (listener in closeListeners) runCatching(listener).onFailure { log("Close listener failed", it) }
    }

    private fun send(message: JsonObject): Boolean {
        if (closed.get()) return false
        return try {
            writer.write(GSON.toJson(message))
            true
        } catch (e: Exception) {
            log("Write failed", e)
            close()
            false
        }
    }

    private fun readLoop() {
        try {
            while (!closed.get()) {
                val body = reader.read() ?: break
                handleBody(body)
            }
        } catch (e: Exception) {
            if (!closed.get()) log("Read failed", e)
        } finally {
            close()
        }
    }

    /** Visible for tests. */
    internal fun handleBody(body: String) {
        val element = try {
            JsonParser.parseString(body)
        } catch (e: Exception) {
            log("Invalid JSON from peer", e)
            sendError(JsonNull.INSTANCE, ErrorCodes.PARSE_ERROR, "Parse error")
            return
        }
        if (!element.isJsonObject) {
            sendError(JsonNull.INSTANCE, ErrorCodes.INVALID_REQUEST, "Expected a JSON object")
            return
        }
        val message = element.asJsonObject
        val method = message.get("method")?.takeIf { it.isJsonPrimitive }?.asString
        val id = message.get("id")?.takeIf { !it.isJsonNull }
        when {
            method != null && id != null -> handleRequest(id, method, message.get("params"))
            method != null -> handleNotification(method, message.get("params"))
            id != null -> handleResponse(id, message)
            else -> sendError(JsonNull.INSTANCE, ErrorCodes.INVALID_REQUEST, "Not a request, notification or response")
        }
    }

    private fun handleRequest(id: JsonElement, method: String, params: JsonElement?) {
        val handler = requestHandlers[method]
        if (handler == null) {
            sendError(id, ErrorCodes.METHOD_NOT_FOUND, "Unhandled method $method")
            return
        }
        val key = idKey(id)
        val signal = CancelSignal()
        incoming[key] = signal
        val future = try {
            handler(params, signal)
        } catch (e: Exception) {
            CompletableFuture.failedFuture(e)
        }
        future.whenComplete { result, error ->
            incoming.remove(key)
            when {
                error == null -> sendResult(id, result)
                else -> {
                    val cause = unwrap(error)
                    when {
                        cause is ResponseError -> sendError(id, cause.code, cause.message ?: "Error")
                        signal.isCancelled -> sendError(id, ErrorCodes.REQUEST_CANCELLED, "Request cancelled")
                        else -> {
                            log("Handler for $method failed", cause)
                            sendError(id, ErrorCodes.INTERNAL_ERROR, cause.message ?: cause.javaClass.simpleName)
                        }
                    }
                }
            }
        }
    }

    private fun handleNotification(method: String, params: JsonElement?) {
        if (method == "\$/cancelRequest") {
            val id = params?.takeIf { it.isJsonObject }?.asJsonObject?.get("id") ?: return
            incoming[idKey(id)]?.cancel()
            return
        }
        val handler = notificationHandlers[method] ?: return
        try {
            handler(params)
        } catch (e: Exception) {
            log("Handler for $method failed", e)
        }
    }

    private fun handleResponse(id: JsonElement, message: JsonObject) {
        val future = pending.remove(idKey(id)) ?: return
        val error = message.get("error")
        if (error != null && error.isJsonObject) {
            val code = error.asJsonObject.get("code")?.asInt ?: ErrorCodes.INTERNAL_ERROR
            val text = error.asJsonObject.get("message")?.asString ?: "Error"
            future.completeExceptionally(ResponseError(code, text))
        } else {
            future.complete(message.get("result")?.takeIf { !it.isJsonNull })
        }
    }

    private fun sendResult(id: JsonElement, result: JsonElement?) {
        val message = JsonObject()
        message.addProperty("jsonrpc", "2.0")
        message.add("id", id)
        message.add("result", result ?: JsonNull.INSTANCE)
        send(message)
    }

    private fun sendError(id: JsonElement, code: Int, text: String) {
        val error = JsonObject()
        error.addProperty("code", code)
        error.addProperty("message", text)
        val message = JsonObject()
        message.addProperty("jsonrpc", "2.0")
        message.add("id", id)
        message.add("error", error)
        send(message)
    }

    companion object {
        val GSON: Gson = GsonBuilder().serializeNulls().disableHtmlEscaping().create()

        fun toJson(value: Any?): JsonElement = when (value) {
            null -> JsonNull.INSTANCE
            is JsonElement -> value
            is String -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            else -> GSON.toJsonTree(value)
        }

        private fun idKey(id: JsonElement): String =
            if (id.isJsonPrimitive && id.asJsonPrimitive.isNumber) id.asNumber.toLong().toString() else id.toString()

        private fun unwrap(error: Throwable): Throwable {
            var current = error
            while ((current is java.util.concurrent.CompletionException || current is java.util.concurrent.ExecutionException) &&
                current.cause != null
            ) {
                current = current.cause!!
            }
            return current
        }
    }
}
