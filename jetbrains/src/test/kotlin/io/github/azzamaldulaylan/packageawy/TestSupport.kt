package io.github.azzamaldulaylan.packageawy

import io.github.azzamaldulaylan.packageawy.rpc.JsonRpcConnection
import java.io.PipedInputStream
import java.io.PipedOutputStream

/** Two connections wired to each other through in-memory pipes. */
class ConnectedPair : AutoCloseable {
    private val aToB = PipedOutputStream()
    private val bToA = PipedOutputStream()
    val a = JsonRpcConnection(PipedInputStream(bToA, 1 shl 20), aToB)
    val b = JsonRpcConnection(PipedInputStream(aToB, 1 shl 20), bToA)

    fun start(): ConnectedPair {
        a.start("a")
        b.start("b")
        return this
    }

    override fun close() {
        a.close()
        b.close()
        runCatching { aToB.close() }
        runCatching { bToA.close() }
    }
}
