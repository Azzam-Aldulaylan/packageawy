package io.github.azzamaldulaylan.packageawy.storage

import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors

class StateFileTest {
    @TempDir
    lateinit var dir: Path

    @Test
    fun `updates persist and reload`() {
        val path = dir.resolve("nested/state.json")
        val state = StateFile(path)
        val value = JsonObject().apply { addProperty("rows", 3) }
        state.update("cache", value)
        state.update("flag", JsonPrimitive(true))
        val reloaded = StateFile(path)
        assertEquals(value, reloaded.get("cache"))
        assertEquals(JsonPrimitive(true), reloaded.snapshot().get("flag"))
    }

    @Test
    fun `null removes a key`() {
        val path = dir.resolve("state.json")
        val state = StateFile(path)
        state.update("a", JsonPrimitive(1))
        state.update("a", JsonNull.INSTANCE)
        state.update("b", JsonPrimitive(2))
        state.update("b", null)
        assertTrue(StateFile(path).snapshot().entrySet().isEmpty())
    }

    @Test
    fun `snapshots are copies`() {
        val state = StateFile(dir.resolve("state.json"))
        state.update("a", JsonObject())
        state.snapshot().getAsJsonObject("a").addProperty("mutated", true)
        assertFalse(state.get("a")!!.asJsonObject.has("mutated"))
    }

    @Test
    fun `unreadable file starts empty`() {
        val path = dir.resolve("state.json")
        Files.writeString(path, "not json")
        assertNull(StateFile(path).get("a"))
    }

    @Test
    fun `scheduled writes land after flush`() {
        val scheduler = Executors.newSingleThreadScheduledExecutor()
        try {
            val path = dir.resolve("state.json")
            val state = StateFile(path, scheduler, flushDelayMs = 60_000)
            state.update("a", JsonPrimitive(1))
            assertFalse(Files.exists(path))
            state.flush()
            assertEquals(JsonPrimitive(1), StateFile(path).get("a"))
        } finally {
            scheduler.shutdownNow()
        }
    }
}
