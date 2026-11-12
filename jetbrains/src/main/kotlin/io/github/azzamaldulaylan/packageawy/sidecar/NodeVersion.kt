package io.github.azzamaldulaylan.packageawy.sidecar

import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

/**
 * The Node.js floor of the sidecar: a bundled package (ini) declares
 * `^18.17.0 || >=20.5.0`. Checked before launch so the IDE can say why the
 * engine does not start. The sidecar checks the same range itself
 * (src/sidecar/nodeVersion.ts).
 */
object NodeVersion {
    const val REQUIREMENT = "Packageawy requires a stable Node.js release: 18.17.x through 18.x, or 20.5.0 or newer."

    /** A full vX.Y.Z, and a prerelease or nightly suffix, which is outside the declared range. */
    private val VERSION = Regex("""^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$""")

    /**
     * The message to show for `node --version` output, or null when it is
     * supported or cannot be read. An unreadable version is left to the
     * sidecar, which checks again when it starts.
     */
    fun unsupportedMessage(versionOutput: String): String? {
        val text = versionOutput.trim()
        val match = VERSION.matchEntire(text) ?: return null
        val major = match.groupValues[1].toIntOrNull() ?: return null
        val minor = match.groupValues[2].toIntOrNull() ?: return null
        match.groupValues[3].toIntOrNull() ?: return null
        val prerelease = match.groupValues[4].isNotEmpty()
        val supported = !prerelease && ((major == 18 && minor >= 17) || (major == 20 && minor >= 5) || major > 20)
        return if (supported) null else "$REQUIREMENT Found $text."
    }

    /** `node --version`, or null when it could not be read. The sidecar then checks for itself. */
    fun probe(node: String): String? = runCatching {
        val process = ProcessBuilder(node, "--version").redirectErrorStream(true).start()
        process.outputStream.close()
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            return null
        }
        if (process.exitValue() != 0) return null
        process.inputStream.readBytes().toString(StandardCharsets.UTF_8).trim().ifEmpty { null }
    }.getOrNull()
}
