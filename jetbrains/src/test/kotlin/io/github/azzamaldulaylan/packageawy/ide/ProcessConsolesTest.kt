package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.openapi.util.Key
import io.github.azzamaldulaylan.packageawy.host.ProcessStart
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

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
        // Waits on stdin, so it runs until stopped.
        dir.resolve("Wait.java").toFile().writeText("class Wait { public static void main(String[] a) throws Exception { System.in.read(); } }")
        val handler = ProcessConsoles.launch(request("Wait.java")) { exits.add(it) }
        handler.startNotify()
        Thread.sleep(500)
        handler.destroyProcess()
        val code = exits.poll(30, TimeUnit.SECONDS)
        assertNotEquals(0, code)
        Thread.sleep(200)
        assertTrue(exits.isEmpty())
    }
}
