package io.github.azzamaldulaylan.packageawy.settings

import com.google.gson.JsonParser
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class SettingsStateTest {
    private fun contributed() = JsonParser.parseString(
        Files.readString(Path.of(System.getProperty("user.dir")).resolve("../package.json").normalize())
    ).asJsonObject.getAsJsonObject("contributes").getAsJsonObject("configuration").getAsJsonObject("properties")

    @Test
    fun `covers every VS Code setting with the same defaults`() {
        val properties = contributed()
        val snapshot = SettingsState().snapshot()
        assertEquals(properties.keySet().map { it.removePrefix("packageawy.") }.toSet(), snapshot.keys)
        for ((key, value) in snapshot) {
            val default = properties.getAsJsonObject("packageawy.$key").get("default")
            when (value) {
                is Boolean -> assertEquals(default.asBoolean, value, key)
                is Int -> assertEquals(default.asInt, value, key)
                is List<*> -> assertEquals(default.asJsonArray.map { it.asString }, value, key)
                else -> error("Unexpected type for $key")
            }
        }
    }

    @Test
    fun `snapshot cleans script names and clamps the cache lifetime`() {
        val state = SettingsState(verificationScripts = mutableListOf(" test ", "", "build"), cacheTtlMinutes = -5)
        assertEquals(listOf("test", "build"), state.snapshot()["upgrade.verificationScripts"])
        assertEquals(0, state.snapshot()["cacheTtlMinutes"])
    }

    @Test
    fun `script field splits on commas and newlines`() {
        assertEquals(listOf("test", "build", "lint"), PackageawyConfigurable.splitScripts("test, build\nlint,,test"))
    }
}
