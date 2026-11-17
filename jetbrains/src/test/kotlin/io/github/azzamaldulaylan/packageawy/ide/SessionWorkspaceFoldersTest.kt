package io.github.azzamaldulaylan.packageawy.ide

import com.google.gson.JsonObject
import io.github.azzamaldulaylan.packageawy.sidecar.Initialize
import io.github.azzamaldulaylan.packageawy.sidecar.WorkspaceFolder
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SessionWorkspaceFoldersTest {
    @TempDir lateinit var dir: Path

    private class Session(lock: Any) {
        val folders = SessionWorkspaceFolders(lock)
        var params: JsonObject? = null
        var ready = false
        var disposed = false
    }

    private class Fixture {
        val lock = Any()
        val startup = SidecarStartup<Session>(lock) { it.disposed = true }

        fun launch(current: Session, setup: (Session) -> Unit) = startup.launch(
            startup.begin()!!, { current }, { it },
            { setup(it); CompletableFuture.completedFuture(Unit) },
            { it.ready = true }, { error, _ -> throw AssertionError("Launch failed", error) },
            { it.disposed = true },
        )

        fun stop() = startup.invalidate()!!.also { it.disposed = true }

        fun update(current: Session, next: List<WorkspaceFolder>, notifications: MutableList<List<WorkspaceFolder>>) {
            current.folders.update(next, { startup.session === current }, notifications::add)
        }
    }

    private fun roots(name: String) = listOf(WorkspaceFolder.of(dir.resolve(name)))

    private fun params(folders: List<WorkspaceFolder>) = Initialize.params(
        folders, true, emptyMap(), JsonObject(), JsonObject(),
    )

    @Test
    fun `superseded initialization setup cannot overwrite replacement folders`() {
        val f = Fixture()
        val old = Session(f.lock)
        val next = Session(f.lock)
        val oldRoots = roots("old")
        val nextRoots = roots("next")
        val oldCaptured = CountDownLatch(1)
        val resumeOld = CountDownLatch(1)
        val nextAssigned = CountDownLatch(1)
        val resumeNext = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val oldLaunch = executor.submit {
                f.launch(old) {
                    val captured = oldRoots
                    oldCaptured.countDown()
                    check(resumeOld.await(30, TimeUnit.SECONDS))
                    val snapshot = it.folders.initialize(captured)
                    it.params = params(snapshot)
                }
            }
            assertTrue(oldCaptured.await(30, TimeUnit.SECONDS))
            assertSame(old, f.stop())
            val nextLaunch = executor.submit {
                f.launch(next) {
                    val snapshot = it.folders.initialize(nextRoots)
                    nextAssigned.countDown()
                    check(resumeNext.await(30, TimeUnit.SECONDS))
                    it.params = params(snapshot)
                }
            }
            assertTrue(nextAssigned.await(30, TimeUnit.SECONDS))
            resumeOld.countDown()
            oldLaunch.get(30, TimeUnit.SECONDS)
            resumeNext.countDown()
            nextLaunch.get(30, TimeUnit.SECONDS)

            assertEquals(WorkspaceFolder.toJson(nextRoots), next.params!!.getAsJsonArray("workspaceFolders"))
            assertSame(next, f.startup.session)
            assertTrue(next.ready)
            assertFalse(next.disposed)
            assertFalse(old.ready)
            assertTrue(old.disposed)
            val notifications = ArrayList<List<WorkspaceFolder>>()
            f.update(next, nextRoots, notifications)
            assertTrue(notifications.isEmpty(), "Replacement folder tracking must retain its own roots")
        } finally {
            resumeOld.countDown()
            resumeNext.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `queued folder update from a superseded session is ignored`() {
        val f = Fixture()
        val old = Session(f.lock)
        val next = Session(f.lock)
        f.launch(old) { it.folders.initialize(roots("old")) }
        val captured = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        val staleNotifications = ArrayList<List<WorkspaceFolder>>()
        try {
            val update = executor.submit {
                val folders = roots("stale-update")
                captured.countDown()
                check(resume.await(30, TimeUnit.SECONDS))
                f.update(old, folders, staleNotifications)
            }
            assertTrue(captured.await(30, TimeUnit.SECONDS))
            f.stop()
            val nextRoots = roots("next")
            f.launch(next) { it.folders.initialize(nextRoots) }
            resume.countDown()
            update.get(30, TimeUnit.SECONDS)

            assertTrue(staleNotifications.isEmpty())
            val notifications = ArrayList<List<WorkspaceFolder>>()
            f.update(next, nextRoots, notifications)
            val changed = roots("changed")
            f.update(next, changed, notifications)
            f.update(next, changed, notifications)
            assertEquals(listOf(changed), notifications)
            assertSame(next, f.startup.session)
        } finally {
            resume.countDown()
            executor.shutdownNow()
        }
    }
}
