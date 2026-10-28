package io.github.azzamaldulaylan.packageawy.sidecar

import io.github.azzamaldulaylan.packageawy.rpc.JsonRpcConnection
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

/** A running `node sidecar.js` and the JSON-RPC connection over its stdio. */
class SidecarProcess private constructor(
    private val process: Process,
    val connection: JsonRpcConnection,
) : AutoCloseable {

    val isAlive: Boolean get() = process.isAlive

    override fun close() {
        connection.close()
        runCatching { process.outputStream.close() }
        if (!process.waitFor(2, TimeUnit.SECONDS)) {
            process.destroy()
            if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly()
        }
    }

    companion object {
        /**
         * Starts the sidecar. Stderr goes to `onStderr` line by line. The
         * connection is returned unstarted so handlers can be registered first.
         */
        fun start(
            node: String,
            script: File,
            environment: Map<String, String>,
            log: (String, Throwable?) -> Unit,
            onStderr: (String) -> Unit,
        ): SidecarProcess {
            val builder = ProcessBuilder(node, script.absolutePath)
                .directory(script.parentFile)
                .redirectInput(ProcessBuilder.Redirect.PIPE)
                .redirectOutput(ProcessBuilder.Redirect.PIPE)
                .redirectError(ProcessBuilder.Redirect.PIPE)
            builder.environment().putAll(environment)
            val process = builder.start()
            val stderr = Thread({
                process.errorStream.bufferedReader(StandardCharsets.UTF_8).useLines { lines -> lines.forEach(onStderr) }
            }, "Packageawy sidecar stderr")
            stderr.isDaemon = true
            stderr.start()
            val connection = JsonRpcConnection(process.inputStream, process.outputStream, log)
            return SidecarProcess(process, connection)
        }
    }
}
