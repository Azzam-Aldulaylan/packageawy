package io.github.azzamaldulaylan.packageawy.rpc

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.github.azzamaldulaylan.packageawy.ConnectedPair
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class RestartHandshakeTest {
    private val pair = ConnectedPair()
    private val calls = LinkedBlockingQueue<Pair<String, String>>()

    @AfterEach
    fun close() = pair.close()

    private fun reply(params: JsonElement?, state: String): JsonElement = JsonObject().apply {
        addProperty("sessionId", Params.of(params).string("sessionId"))
        addProperty("state", state)
    }

    private fun register(prepare: String = "idle", commit: String = "idle") {
        pair.b.onRequest("restart/prepare") { params, _ ->
            calls.add("prepare" to Params.of(params).string("sessionId"))
            CompletableFuture.completedFuture(reply(params, prepare))
        }
        pair.b.onRequest("restart/commit") { params, _ ->
            calls.add("commit" to Params.of(params).string("sessionId"))
            CompletableFuture.completedFuture(reply(params, commit))
        }
        pair.b.onNotification("restart/cancel") { params -> calls.add("cancel" to Params.of(params).string("sessionId")) }
    }

    private fun next(): Pair<String, String> = calls.poll(5, TimeUnit.SECONDS) ?: error("No restart message")

    @Test
    fun `idle prepare is followed by commit with the same fresh session`() {
        register(); pair.start()
        assertTrue(RestartHandshake(pair.a).prepareAndCommit().get(5, TimeUnit.SECONDS))
        val prepare = next(); val commit = next()
        assertEquals("prepare", prepare.first)
        assertEquals("commit" to prepare.second, commit)
        assertEquals(4, UUID.fromString(prepare.second).version())
        assertTrue(RestartHandshake(pair.a).prepareAndCommit().get(5, TimeUnit.SECONDS))
        assertNotEquals(prepare.second, next().second)
    }

    @Test
    fun `busy and unknown prepare refuse and cancel without commit`() {
        for (state in listOf("busy", "unknown")) {
            register(prepare = state); if (state == "busy") pair.start()
            assertFalse(RestartHandshake(pair.a).prepareAndCommit().get(5, TimeUnit.SECONDS))
            val prepare = next()
            assertEquals("prepare", prepare.first)
            assertEquals("cancel" to prepare.second, next())
        }
    }

    @Test
    fun `busy and unknown commit refuse and cancel the prepared session`() {
        for (state in listOf("busy", "unknown")) {
            register(commit = state); if (state == "busy") pair.start()
            assertFalse(RestartHandshake(pair.a).prepareAndCommit().get(5, TimeUnit.SECONDS))
            val prepare = next()
            assertEquals("commit" to prepare.second, next())
            assertEquals("cancel" to prepare.second, next())
        }
    }

    @Test
    fun `restart is not accepted before commit acknowledgement`() {
        register()
        val commit = CompletableFuture<JsonElement?>()
        var params: JsonElement? = null
        pair.b.onRequest("restart/commit") { value, _ ->
            params = value
            calls.add("commit" to Params.of(value).string("sessionId"))
            commit
        }
        pair.start()
        val accepted = RestartHandshake(pair.a).prepareAndCommit()
        next(); next()
        assertFalse(accepted.isDone)
        commit.complete(reply(params, "idle"))
        assertTrue(accepted.get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `stale prepare or commit acknowledgement never authorizes a restart`() {
        for (method in listOf("restart/prepare", "restart/commit")) {
            register()
            pair.b.onRequest(method) { params, _ ->
                calls.add(method.substringAfter('/') to Params.of(params).string("sessionId"))
                CompletableFuture.completedFuture(JsonObject().apply {
                    addProperty("sessionId", UUID.randomUUID().toString()); addProperty("state", "idle")
                })
            }
            if (method == "restart/prepare") pair.start()
            assertFalse(RestartHandshake(pair.a).prepareAndCommit().get(5, TimeUnit.SECONDS))
            val prepare = next()
            if (method == "restart/commit") assertEquals("commit" to prepare.second, next())
            assertEquals("cancel" to prepare.second, next())
        }
    }

    @Test
    fun `prepare timeout cancels and refuses`() {
        register()
        pair.b.onRequest("restart/prepare") { params, _ ->
            calls.add("prepare" to Params.of(params).string("sessionId")); CompletableFuture()
        }
        pair.start()
        assertFalse(RestartHandshake(pair.a, 100).prepareAndCommit().get(5, TimeUnit.SECONDS))
        val prepare = next()
        assertEquals("cancel" to prepare.second, next())
    }

    @Test
    fun `commit timeout cancels and refuses`() {
        register()
        pair.b.onRequest("restart/commit") { params, _ ->
            calls.add("commit" to Params.of(params).string("sessionId")); CompletableFuture()
        }
        pair.start()
        assertFalse(RestartHandshake(pair.a, 100).prepareAndCommit().get(5, TimeUnit.SECONDS))
        val prepare = next()
        assertEquals("commit" to prepare.second, next())
        assertEquals("cancel" to prepare.second, next())
    }

    @Test
    fun `disconnect during prepare refuses even without a response`() {
        register()
        pair.b.onRequest("restart/prepare") { _, _ -> pair.a.close(); CompletableFuture() }
        pair.start()
        assertFalse(RestartHandshake(pair.a).prepareAndCommit().get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `validators reject malformed or mismatched restart messages`() {
        val sessionId = UUID.randomUUID().toString()
        for (raw in listOf("null", "[]", "{}", "{\"sessionId\":7,\"state\":\"idle\"}",
            "{\"sessionId\":\"$sessionId\",\"state\":\"running\"}",
            "{\"sessionId\":\"$sessionId\",\"state\":\"idle\",\"extra\":true}",
            "{\"sessionId\":\"${UUID.randomUUID()}\",\"state\":\"idle\"}")) {
            assertThrows(ResponseError::class.java) { RestartHandshake.state(JsonParser.parseString(raw), sessionId) }
        }
        assertThrows(IllegalArgumentException::class.java) { RestartHandshake.params("old") }
        for (state in listOf("idle", "busy", "unknown")) {
            assertEquals(state, RestartHandshake.state(JsonParser.parseString("{\"sessionId\":\"$sessionId\",\"state\":\"$state\"}"), sessionId))
        }
    }
}
