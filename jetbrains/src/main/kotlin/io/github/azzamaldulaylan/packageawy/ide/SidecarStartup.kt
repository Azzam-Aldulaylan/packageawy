package io.github.azzamaldulaylan.packageawy.ide

import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean

/** Fences each launch and owns its resources until initialization succeeds. */
internal class SidecarStartup<S : Any>(private val lock: Any, private val dispose: (S) -> Unit) {
    private var generation = 0L
    private var startingGeneration: Long? = null
    var session: S? = null
        private set
    val starting: Boolean get() = synchronized(lock) { startingGeneration != null }

    fun begin(): Long? = synchronized(lock) {
        if (session != null || startingGeneration != null) return null
        (++generation).also { startingGeneration = it }
    }

    fun invalidate(): S? = synchronized(lock) {
        generation++
        startingGeneration = null
        session.also { session = null }
    }

    fun release(current: S): Boolean = synchronized(lock) {
        if (session !== current) return false
        session = null
        true
    }

    fun <P : Any> launch(
        token: Long,
        spawn: () -> P,
        prepare: (P) -> S,
        initialize: (S) -> CompletableFuture<*>,
        ready: (S) -> Unit,
        failure: (Throwable, Boolean) -> Unit,
        stopProcess: (P) -> Unit,
    ) {
        var process: P? = null
        var current: S? = null
        val cleaned = AtomicBoolean(false)
        fun clean() {
            if (!cleaned.compareAndSet(false, true)) return
            val active = current
            if (active != null) dispose(active) else process?.let(stopProcess)
        }
        fun fail(error: Throwable, initializing: Boolean = false) {
            val report = synchronized(lock) {
                if (generation != token || (current != null && session !== current)) false else {
                    if (session === current) session = null
                    if (startingGeneration == token) startingGeneration = null
                    true
                }
            }
            clean()
            if (report) failure(error, initializing)
        }
        try {
            if (synchronized(lock) { generation != token }) return
            val child = spawn()
            process = child
            val active = prepare(child)
            current = active
            val published = synchronized(lock) {
                if (generation != token) false else {
                    session = active
                    true
                }
            }
            if (!published) { clean(); return }
            initialize(active).whenComplete { _, error ->
                if (error != null) {
                    fail(error, initializing = true)
                } else {
                    try {
                        val accepted = synchronized(lock) {
                            if (generation != token || session !== active) false else {
                                ready(active)
                                true
                            }
                        }
                        if (!accepted) clean()
                    } catch (e: Exception) {
                        fail(e)
                    }
                }
            }
        } catch (e: Exception) {
            fail(e)
        } finally {
            synchronized(lock) {
                if (startingGeneration == token) startingGeneration = null
            }
        }
    }
}
