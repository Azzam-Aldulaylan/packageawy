package io.github.azzamaldulaylan.packageawy.rpc

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException

class MessageFramingTest {
    private fun reader(text: String) = MessageReader(ByteArrayInputStream(text.toByteArray(Charsets.UTF_8)))

    @Test
    fun `writes and reads back several messages`() {
        val out = ByteArrayOutputStream()
        val writer = MessageWriter(out)
        writer.write("""{"a":1}""")
        writer.write("""{"b":"ünïcødé ✓"}""")
        val r = MessageReader(ByteArrayInputStream(out.toByteArray()))
        assertEquals("""{"a":1}""", r.read())
        assertEquals("""{"b":"ünïcødé ✓"}""", r.read())
        assertNull(r.read())
    }

    @Test
    fun `content length counts bytes not characters`() {
        val out = ByteArrayOutputStream()
        MessageWriter(out).write("é")
        assertEquals("Content-Length: 2\r\n\r\né", out.toString(Charsets.UTF_8))
    }

    @Test
    fun `accepts other headers and any header case`() {
        val r = reader("content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}")
        assertEquals("{}", r.read())
    }

    @Test
    fun `accepts bare newlines`() {
        assertEquals("{}", reader("Content-Length: 2\n\n{}").read())
    }

    @Test
    fun `missing content length fails`() {
        assertThrows<IOException> { reader("Content-Type: x\r\n\r\n{}").read() }
    }

    @Test
    fun `invalid content length fails`() {
        assertThrows<IOException> { reader("Content-Length: abc\r\n\r\n{}").read() }
    }

    @Test
    fun `truncated body fails`() {
        assertThrows<EOFException> { reader("Content-Length: 10\r\n\r\n{}").read() }
    }

    @Test
    fun `stream ending inside headers fails`() {
        assertThrows<EOFException> { reader("Content-Length: 2\r\n").read() }
    }

    @Test
    fun `oversized message is refused`() {
        val r = MessageReader(ByteArrayInputStream("Content-Length: 100\r\n\r\n".toByteArray()), maxContentLength = 10)
        assertThrows<IOException> { r.read() }
    }
}
