package io.github.azzamaldulaylan.packageawy.rpc

import com.google.gson.JsonElement
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Admission belongs to this attempt until cancel or the sidecar exits. */
class RestartHandshake(
    private val connection: JsonRpcConnection,
    private val timeoutMs: Long = 5_000,
) {
    fun prepareAndCommit(): CompletableFuture<Boolean> {
        val sessionId = UUID.randomUUID().toString()
        val params = params(sessionId)
        return connection.sendRequest("restart/prepare", params).orTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .thenCompose { reply ->
                if (state(reply, sessionId) != "idle") CompletableFuture.completedFuture(false)
                else connection.sendRequest("restart/commit", params).orTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .thenApply { state(it, sessionId) == "idle" }
            }.handle { accepted, error ->
                if (error != null || accepted != true) {
                    connection.sendNotification("restart/cancel", params)
                    false
                } else true
            }
    }

    companion object {
        const val REFUSAL = "Cannot restart while a dependency change is running or its outcome is unknown."
        private val SESSION_ID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)

        internal fun params(sessionId: String): Map<String, String> {
            require(SESSION_ID.matches(sessionId)) { "sessionId must be a UUID" }
            return mapOf("sessionId" to sessionId)
        }

        internal fun state(reply: JsonElement?, sessionId: String): String {
            if (reply == null || !reply.isJsonObject || reply.asJsonObject.keySet() != setOf("sessionId", "state")) {
                throw ResponseError(ErrorCodes.INVALID_PARAMS, "Invalid restart reply")
            }
            val fields = Params.of(reply)
            val receivedId = fields.string("sessionId")
            if (!SESSION_ID.matches(receivedId) || receivedId != sessionId) {
                throw ResponseError(ErrorCodes.INVALID_PARAMS, "Stale restart reply")
            }
            return fields.string("state").also {
                if (it !in setOf("idle", "busy", "unknown")) throw ResponseError(ErrorCodes.INVALID_PARAMS, "Invalid restart state")
            }
        }
    }
}
