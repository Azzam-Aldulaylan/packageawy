package io.github.azzamaldulaylan.packageawy.rpc

import com.google.gson.JsonElement
import com.google.gson.JsonPrimitive
import io.github.azzamaldulaylan.packageawy.ConnectedPair
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class JsonRpcConnectionTest {
    private val pair = ConnectedPair()

    @AfterEach
    fun close() = pair.close()

    private fun <T> CompletableFuture<T>.await(): T = get(5, TimeUnit.SECONDS)

    private fun errorCode(future: CompletableFuture<*>): Int {
        val error = runCatching { future.await() }.exceptionOrNull()
        val cause = (error as? ExecutionException)?.cause as? ResponseError ?: throw AssertionError("Expected ResponseError, got $error")
        return cause.code
    }

    @Test
    fun `request gets the handler result`() {
        pair.b.onRequest("math/add") { params, _ ->
            val p = Params.of(params)
            CompletableFuture.completedFuture(JsonPrimitive(p.optInt("x")!! + p.optInt("y")!!))
        }
        pair.start()
        assertEquals(5, pair.a.sendRequest("math/add", mapOf("x" to 2, "y" to 3)).await()!!.asInt)
    }

    @Test
    fun `null result arrives as null`() {
        pair.b.onRequest("noop") { _, _ -> CompletableFuture.completedFuture(null) }
        pair.start()
        assertEquals(null, pair.a.sendRequest("noop", null).await())
    }

    @Test
    fun `notifications arrive in order`() {
        val seen = LinkedBlockingQueue<Int>()
        pair.b.onNotification("tick") { seen.add(it!!.asJsonObject["n"].asInt) }
        pair.start()
        repeat(50) { pair.a.sendNotification("tick", mapOf("n" to it)) }
        val received = (0 until 50).map { seen.poll(5, TimeUnit.SECONDS) }
        assertEquals((0 until 50).toList(), received)
    }

    @Test
    fun `unknown method is method not found`() {
        pair.start()
        assertEquals(ErrorCodes.METHOD_NOT_FOUND, errorCode(pair.a.sendRequest("nope", null)))
    }

    @Test
    fun `bad params are invalid params`() {
        pair.b.onRequest("needs") { params, _ ->
            Params.of(params).string("name")
            CompletableFuture.completedFuture(null)
        }
        pair.start()
        assertEquals(ErrorCodes.INVALID_PARAMS, errorCode(pair.a.sendRequest("needs", mapOf("name" to 3))))
    }

    @Test
    fun `handler failure is an internal error`() {
        pair.b.onRequest("boom") { _, _ -> throw IllegalStateException("boom") }
        pair.start()
        assertEquals(ErrorCodes.INTERNAL_ERROR, errorCode(pair.a.sendRequest("boom", null)))
    }

    @Test
    fun `cancel request cancels the handler`() {
        val started = CompletableFuture<Unit>()
        val signalled = CompletableFuture<Boolean>()
        pair.b.onRequest("slow") { _, cancel ->
            val result = CompletableFuture<JsonElement?>()
            cancel.onCancel {
                signalled.complete(true)
                result.completeExceptionally(RuntimeException("cancelled"))
            }
            started.complete(Unit)
            result
        }
        pair.start()
        val future = pair.a.sendRequest("slow", null)
        started.await()
        pair.a.sendNotification("\$/cancelRequest", mapOf("id" to 1))
        assertTrue(signalled.await())
        assertEquals(ErrorCodes.REQUEST_CANCELLED, errorCode(future))
    }

    @Test
    fun `closing fails pending requests and notifies listeners`() {
        val closed = CompletableFuture<Unit>()
        pair.b.onRequest("never") { _, _ -> CompletableFuture() }
        pair.a.onClose { closed.complete(Unit) }
        pair.start()
        val future = pair.a.sendRequest("never", null)
        pair.a.close()
        closed.await()
        assertTrue(runCatching { future.await() }.isFailure)
        assertTrue(runCatching { pair.a.sendRequest("x", null).await() }.isFailure)
    }

    @Test
    fun `peer closing its stream closes the connection`() {
        val closed = CompletableFuture<Unit>()
        pair.a.onClose { closed.complete(Unit) }
        pair.start()
        pair.b.close()
        pair.close()
        closed.await()
        assertTrue(pair.a.isClosed)
    }
}
