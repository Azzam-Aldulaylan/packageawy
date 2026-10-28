package io.github.azzamaldulaylan.packageawy.rpc

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets

/** Reads LSP style messages: `Content-Length: N`, a blank line, then N bytes of UTF-8 JSON. */
class MessageReader(private val input: InputStream, private val maxContentLength: Int = 64 * 1024 * 1024) {

    /** Returns the next message body, or null at a clean end of stream. */
    fun read(): String? {
        var contentLength = -1
        var sawHeader = false
        while (true) {
            val line = readHeaderLine() ?: if (sawHeader) throw EOFException("Stream ended inside headers") else return null
            if (line.isEmpty()) {
                if (!sawHeader) continue
                break
            }
            sawHeader = true
            val colon = line.indexOf(':')
            if (colon <= 0) throw IOException("Malformed header: $line")
            val name = line.substring(0, colon).trim()
            val value = line.substring(colon + 1).trim()
            if (name.equals("Content-Length", ignoreCase = true)) {
                contentLength = value.toIntOrNull() ?: throw IOException("Invalid Content-Length: $value")
            }
        }
        if (contentLength < 0) throw IOException("Missing Content-Length header")
        if (contentLength > maxContentLength) throw IOException("Content-Length $contentLength is too large")
        val body = input.readNBytes(contentLength)
        if (body.size < contentLength) throw EOFException("Stream ended inside a message body")
        return String(body, StandardCharsets.UTF_8)
    }

    private fun readHeaderLine(): String? {
        val buffer = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (buffer.size() == 0) null else throw EOFException("Stream ended inside a header")
            if (b == '\n'.code) break
            buffer.write(b)
            if (buffer.size() > 8192) throw IOException("Header line is too long")
        }
        val bytes = buffer.toByteArray()
        val length = if (bytes.isNotEmpty() && bytes.last() == '\r'.code.toByte()) bytes.size - 1 else bytes.size
        return String(bytes, 0, length, StandardCharsets.US_ASCII)
    }
}

/** Writes LSP style messages. Safe to call from several threads. */
class MessageWriter(private val output: OutputStream) {
    private val lock = Any()

    fun write(body: String) {
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        val header = "Content-Length: ${bytes.size}\r\n\r\n".toByteArray(StandardCharsets.US_ASCII)
        synchronized(lock) {
            output.write(header)
            output.write(bytes)
            output.flush()
        }
    }
}
