package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.openapi.util.Key
import io.github.azzamaldulaylan.packageawy.host.ProcessStart
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap

class ProcessConsolesTest {
    @TempDir
    lateinit var dir: Path

    private val java = ProcessHandle.current().info().command().orElseThrow()

    private fun request(vararg args: String) = ProcessStart(java, args.toList(), dir.toString(), "Packageawy: test", "test")

    @Test
    fun `arguments stay literal and the cwd is the project`() {
        val args = listOf("install", "a b@1.0.0", "\$(touch x);", "--ignore-scripts")
        val commandLine = ProcessConsoles.commandLine(ProcessStart(java, args, dir.toString(), "t", "s"))
        assertEquals(java, commandLine.exePath)
        assertEquals(args, commandLine.parametersList.list)
        assertEquals(dir.toFile(), commandLine.workDirectory)
    }

    @Test
    fun `reports a zero exit code`() {
        val exits = LinkedBlockingQueue<Int?>()
        val handler = ProcessConsoles.launch(request("-version")) { exits.add(it) }
        handler.startNotify()
        assertEquals(0, exits.poll(30, TimeUnit.SECONDS))
    }

    @Test
    fun `reports a failing exit code and prints it in the console`() {
        val exits = LinkedBlockingQueue<Int?>()
        val output = CopyOnWriteArrayList<String>()
        val handler = ProcessConsoles.launch(request("-cp", dir.toString(), "NoSuchMainClass")) { exits.add(it) }
        handler.addProcessListener(object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                output.add(event.text)
            }
        })
        handler.startNotify()
        assertEquals(1, exits.poll(30, TimeUnit.SECONDS))
        handler.waitFor(5_000)
        assertTrue(output.joinToString("").contains("exit code 1"), output.joinToString(""))
    }

    @Test
    fun `stopping from the console reports one non zero exit`() {
        val exits = LinkedBlockingQueue<Int?>()
        val ready = CountDownLatch(1)
        val output = StringBuilder()
        // Waits on stdin, so it runs until stopped.
        dir.resolve("Wait.java").toFile().writeText("class Wait { public static void main(String[] a) throws Exception { System.out.println(\"READY\"); System.out.flush(); System.in.read(); } }")
        val handler = ProcessConsoles.launch(request("Wait.java")) { exits.add(it) }
        handler.addProcessListener(object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                synchronized(output) {
                    output.append(event.text)
                    if (output.contains("READY")) ready.countDown()
                }
            }
        })
        try {
            handler.startNotify()
            assertTrue(ready.await(30, TimeUnit.SECONDS), "The child did not become ready")
            handler.destroyProcess()
            val code = exits.poll(30, TimeUnit.SECONDS)
            assertNotNull(code, "The exit callback did not run")
            assertNotEquals(0, code)
            assertTrue(handler.waitFor(30_000), "The process did not finish")
            assertTrue(exits.isEmpty(), "The exit callback ran more than once")
        } finally {
            if (!handler.isProcessTerminated) handler.destroyProcess()
        }
    }

    @Test
    fun `success removes only its descriptor on the UI queue after acknowledgement`() {
        val tabs = ConcurrentHashMap<String, Any>()
        val descriptor = Any()
        val other = Any()
        tabs["test"] = descriptor
        tabs["other"] = other
        val queue = mutableListOf<() -> Unit>()
        val removed = mutableListOf<Any>()
        val completion = ConsoleCompletion(tabs, "test", queue::add, { true }, removed::add)
        completion.shown(descriptor)
        completion.exited(0)
        assertTrue(queue.isEmpty())
        completion.closeAfterSuccess()
        completion.closeAfterSuccess()
        assertTrue(removed.isEmpty())
        assertEquals(1, queue.size)
        queue.single().invoke()
        assertEquals(listOf(descriptor), removed)
        assertEquals(mapOf("other" to other), tabs)
    }

    @Test
    fun `failure unknown cancellation replacement and disposal all keep consoles`() {
        for (scenario in listOf("failure", "unknown", "cancelled", "cancelled on UI", "reused", "closed", "disposed", "no descriptor")) {
            val tabs = ConcurrentHashMap<String, Any>()
            val descriptor = Any()
            tabs["test"] = descriptor
            val queue = mutableListOf<() -> Unit>()
            val removed = mutableListOf<Any>()
            val completion = ConsoleCompletion(tabs, "test", queue::add, { scenario != "disposed" }, removed::add)
            if (scenario != "no descriptor") completion.shown(descriptor)
            completion.exited(when (scenario) { "failure" -> 1; "unknown" -> null; else -> 0 })
            if (scenario == "cancelled") completion.cancel()
            completion.closeAfterSuccess()
            if (scenario == "cancelled on UI") completion.cancel()
            if (scenario == "reused") tabs["test"] = Any()
            if (scenario == "closed") tabs.clear()
            queue.forEach { it() }
            assertTrue(removed.isEmpty(), scenario)
            if (scenario != "closed") assertTrue(tabs.containsKey("test"), scenario)
        }
    }

    @Test
    fun `descriptor disposal drops ownership listeners and cannot erase a replacement`() {
        val tabs = ConcurrentHashMap<String, Any>()
        val descriptor = Any()
        val replacement = Any()
        tabs["test"] = descriptor
        val queue = mutableListOf<() -> Unit>()
        val removed = mutableListOf<Any>()
        val completion = ConsoleCompletion(tabs, "test", queue::add, { true }, removed::add)
        completion.shown(descriptor)
        completion.exited(0)
        var disposed = 0
        completion.onDisposed { disposed += 1 }
        val unsubscribed = completion.onDisposed { error("Released handles must not be retained") }
        unsubscribed.close()
        completion.closeAfterSuccess()
        tabs["test"] = replacement
        completion.disposed()
        completion.disposed()
        completion.onDisposed { disposed += 1 }
        queue.forEach { it() }
        assertEquals(2, disposed)
        assertTrue(tabs["test"] === replacement)
        assertTrue(removed.isEmpty())
    }

    @Test
    fun `manual descriptor disposal removes its tab mapping without requesting a close`() {
        val tabs = ConcurrentHashMap<String, Any>()
        val descriptor = Any()
        tabs["test"] = descriptor
        val completion = ConsoleCompletion(tabs, "test", { error("No UI close expected") }, { true }, { error("Already disposed") })
        completion.shown(descriptor)
        completion.disposed()
        completion.exited(0)
        completion.closeAfterSuccess()
        assertTrue(tabs.isEmpty())
    }

    @Test
    fun `cleanup cannot erase a replacement mapping`() {
        // Even a replacement that compares equal is a different descriptor.
        data class Descriptor(val title: String)
        val tabs = ConcurrentHashMap<String, Descriptor>()
        val descriptor = Descriptor("Packageawy")
        val replacement = Descriptor("Packageawy")
        tabs["test"] = descriptor
        val queue = mutableListOf<() -> Unit>()
        val completion = ConsoleCompletion(tabs, "test", queue::add, { true }, { tabs["test"] = replacement })
        completion.shown(descriptor)
        completion.exited(0)
        completion.closeAfterSuccess()
        queue.single().invoke()
        assertTrue(tabs["test"] === replacement)
    }
    @Test
    fun `reveal checks the exact descriptor on the UI queue and never shows a replacement`() {
        for (scenario in listOf("open", "closed", "replaced", "project disposed")) {
            val tabs = ConcurrentHashMap<String, Any>()
            val own = Any()
            tabs["test"] = own
            val queue = mutableListOf<() -> Unit>()
            val shown = mutableListOf<Any>()
            val completion = ConsoleCompletion(tabs, "test", queue::add, { scenario != "project disposed" }, { error("Reveal must not close") })
            completion.shown(own)
            completion.exited(7)
            val result = completion.reveal(shown::add)
            assertFalse(result.isDone)
            if (scenario == "closed") completion.disposed()
            if (scenario == "replaced") tabs["test"] = Any()
            queue.single().invoke()
            assertEquals(scenario == "open", result.get())
            assertEquals(if (scenario == "open") listOf(own) else emptyList(), shown)
        }
    }

}
