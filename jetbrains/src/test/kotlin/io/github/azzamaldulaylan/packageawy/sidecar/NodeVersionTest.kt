package io.github.azzamaldulaylan.packageawy.sidecar

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class NodeVersionTest {
    private val requirement = "Packageawy requires a stable Node.js release: 18.17.x through 18.x, or 20.5.0 or newer."

    @Test
    fun `supported versions start the engine`() {
        for (version in listOf("v18.17.0", "v18.20.4", "v20.5.0", "v22.12.0", "v24.1.0\n", "20.9.0")) {
            assertNull(NodeVersion.unsupportedMessage(version), version)
        }
    }

    @Test
    fun `older versions, prereleases and nightlies get the message the IDE shows`() {
        for (version in listOf("v18.16.1", "v16.20.2", "v19.9.0", "v20.4.0", "v18.17.0-pre", "v20.5.0-nightly20230101abcdef")) {
            assertEquals("$requirement Found $version.", NodeVersion.unsupportedMessage(version))
        }
    }

    @Test
    fun `an unreadable version is left to the sidecar`() {
        for (version in listOf("garbage", "", "v20.5", "x20.5.0y", "v99999999999999999999.0.0", "v20.5.0 extra")) {
            assertNull(NodeVersion.unsupportedMessage(version), version)
        }
    }
}
