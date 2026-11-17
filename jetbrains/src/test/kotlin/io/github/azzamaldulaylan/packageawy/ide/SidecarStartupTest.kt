package io.github.azzamaldulaylan.packageawy.ide

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SidecarStartupTest {
    private class Child {
        var stopped = false
        fun stop() { stopped = true }
    }

    private class Session(val child: Child) {
        var ready = false
        private val disposed = AtomicBoolean(false)
        fun dispose() { if (disposed.compareAndSet(false, true)) child.stop() }
    }

    private class Fixture {
        val startup = SidecarStartup<Session>(Any(), Session::dispose)
        val child = Child()
        val initialized = CompletableFuture<Unit>()
        val failures = ArrayList<Throwable>()
        fun launch(
            token: Long = startup.begin()!!,
            prepare: (Child) -> Session = ::Session,
            initialize: (Session) -> CompletableFuture<*> = { initialized },
        ) = startup.launch(
            token, { child }, prepare, initialize, { it.ready = true },
            { error, _ -> failures.add(error) }, Child::stop,
        )
    }

    @Test
    fun `initialize rejection releases the session and allows a retry`() {
        val f = Fixture()
        f.launch()
        val first = f.startup.session!!
        f.initialized.completeExceptionally(IllegalStateException("initialize rejected"))
        assertNull(f.startup.session)
        assertFalse(first.ready)
        assertTrue(f.child.stopped)
        assertEquals(1, f.failures.size)

        val retry = Child()
        f.startup.launch(
            f.startup.begin()!!, { retry }, ::Session, { CompletableFuture.completedFuture(Unit) },
            { it.ready = true }, { _, _ -> throw AssertionError("Retry failed") }, Child::stop,
        )
        assertTrue(f.startup.session!!.ready)
        assertSame(retry, f.startup.session!!.child)
        assertFalse(retry.stopped)
    }

    @Test
    fun `an exception after spawn stops the unpublished process`() {
        val f = Fixture()
        f.launch(prepare = { throw IllegalStateException("handler construction failed") })
        assertTrue(f.child.stopped)
        assertNull(f.startup.session)
        assertFalse(f.startup.starting)
        assertEquals(1, f.failures.size)
        assertNotNull(f.startup.begin())
    }

    @Test
    fun `an exception after publication releases the session and stops the process`() {
        val f = Fixture()
        f.launch(initialize = { throw IllegalStateException("workspace folders failed") })
        assertTrue(f.child.stopped)
        assertNull(f.startup.session)
        assertFalse(f.startup.starting)
        assertEquals(1, f.failures.size)
        assertNotNull(f.startup.begin())
    }

    @Test
    fun `stop during startup prevents publication and stops the process`() {
        val f = Fixture()
        val spawned = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        val token = f.startup.begin()!!
        try {
            val launch = executor.submit {
                f.launch(token, prepare = {
                    spawned.countDown()
                    check(resume.await(30, TimeUnit.SECONDS))
                    Session(it)
                })
            }
            assertTrue(spawned.await(30, TimeUnit.SECONDS))
            assertNull(f.startup.invalidate())
            // A new launch can begin before the old pooled-thread task returns.
            val next = f.startup.begin()
            assertNotNull(next)
            resume.countDown()
            launch.get(30, TimeUnit.SECONDS)
            assertNull(f.startup.session)
            assertTrue(f.child.stopped)
            assertTrue(f.startup.starting, "The old launch must not clear the new launch's flag")
            assertTrue(f.failures.isEmpty())
        } finally {
            resume.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `stop during initialize fences completion and preserves a newer session`() {
        for (reject in listOf(false, true)) {
            val f = Fixture()
            f.launch()
            val old = f.startup.invalidate()!!
            old.dispose()
            val next = Session(Child())
            f.startup.launch(
                f.startup.begin()!!, { next.child }, { next }, { CompletableFuture.completedFuture(Unit) },
                { it.ready = true }, { _, _ -> throw AssertionError("New launch failed") }, Child::stop,
            )
            if (reject) f.initialized.completeExceptionally(IllegalStateException("late failure"))
            else f.initialized.complete(Unit)
            assertFalse(old.ready)
            assertTrue(old.child.stopped)
            assertSame(next, f.startup.session)
            assertTrue(next.ready)
            assertFalse(next.child.stopped)
            assertTrue(f.failures.isEmpty())
        }
    }
}
