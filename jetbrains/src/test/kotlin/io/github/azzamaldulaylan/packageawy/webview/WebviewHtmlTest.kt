package io.github.azzamaldulaylan.packageawy.webview

import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class WebviewHtmlTest {
    private fun html(state: JsonObject? = null) =
        WebviewHtml.build("window.bridge(request)", state, ":root{}", dark = true, performanceDebug = false, nonce = "N0NCE")

    @Test
    fun `csp allows only nonce scripts and the plugin origin`() {
        val page = html()
        val csp = Regex("""Content-Security-Policy" content="([^"]+)"""").find(page)!!.groupValues[1]
        assertTrue(csp.startsWith("default-src 'none'"))
        assertTrue(csp.contains("script-src 'nonce-N0NCE'"))
        assertFalse(csp.contains("unsafe-inline"))
        assertFalse(csp.contains("unsafe-eval"))
        assertEquals(2, Regex("""<script nonce="N0NCE"""").findAll(page).count())
        assertEquals(0, Regex("""<script>""").findAll(page).count())
        assertTrue(page.contains("""src="https://packageawy.local/webview.js""""))
        assertTrue(page.contains("""href="https://packageawy.local/webview.css""""))
        assertTrue(page.contains("""class="vscode-dark""""))
    }

    @Test
    fun `shim defines acquireVsCodeApi and uses the bridge`() {
        val shim = WebviewHtml.shim("window.bridge(request)", null)
        assertTrue(shim.contains("window.acquireVsCodeApi = function"))
        assertTrue(shim.contains("window.bridge(request);"))
        assertTrue(shim.contains("var state = undefined;"))
    }

    @Test
    fun `initial state cannot break out of the script`() {
        val state = JsonObject().apply { addProperty("x", "</script><script>alert(1)</script>") }
        val page = html(state)
        assertFalse(page.contains("</script><script>alert"))
        assertTrue(page.contains("\\u003c/script>"))
    }

    @Test
    fun `receive script wraps the message as a literal`() {
        val message = JsonObject().apply { add("status", JsonPrimitive("loading")) }
        assertEquals("""window.__packageawyReceive({"status":"loading"});""", WebviewHtml.receiveScript(message))
    }

    @Test
    fun `nonces are fresh`() {
        assertNotEquals(WebviewHtml.newNonce(), WebviewHtml.newNonce())
    }
}
