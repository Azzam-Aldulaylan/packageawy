package io.github.azzamaldulaylan.packageawy.webview

import com.google.gson.JsonElement
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.handler.CefResourceHandler
import org.cef.handler.CefResourceRequestHandler
import org.cef.handler.CefResourceRequestHandlerAdapter
import org.cef.misc.BoolRef
import org.cef.network.CefRequest
import javax.swing.JComponent

/**
 * The dashboard webview in JCEF. Serves the page and the bundled assets from
 * [WebviewHtml.ORIGIN], blocks every other URL, and bridges the
 * `acquireVsCodeApi` shim to [onMessage] through a [JBCefJSQuery].
 */
class WebviewPanel(
    parent: Disposable,
    private val onMessage: (JsonElement) -> Unit,
    private val onLoaded: () -> Unit,
) : Disposable {
    private val browser: JBCefBrowser = JBCefBrowser.createBuilder().setEnableOpenDevToolsMenuItem(true).build()
    private val query: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val lock = Any()
    private var loaded = false
    private val queue = ArrayList<String>()

    /** What the page last passed to `setState`. Survives reloads of the page. */
    @Volatile
    var state: JsonElement? = null
        private set

    @Volatile
    private var pageHtml: String = ""

    val component: JComponent get() = browser.component

    init {
        Disposer.register(parent, this)
        Disposer.register(this, browser)
        Disposer.register(this, query)
        query.addHandler { request ->
            handleQuery(request)
            null
        }
        browser.jbCefClient.addRequestHandler(RequestHandler(), browser.cefBrowser)
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (frame.isMain && frame.url == WebviewHtml.INDEX_URL) markLoaded()
            }
        }, browser.cefBrowser)
    }

    /** Loads (or reloads) the page. Messages posted before it finishes loading are queued. */
    fun load(themeCss: String, dark: Boolean, performanceDebug: Boolean) {
        synchronized(lock) {
            loaded = false
            queue.clear()
        }
        pageHtml = WebviewHtml.build(query.inject("request"), state, themeCss, dark, performanceDebug)
        browser.loadURL(WebviewHtml.INDEX_URL)
    }

    fun postMessage(message: JsonElement) = execute(WebviewHtml.receiveScript(message))

    fun applyTheme(vars: Map<String, String>, dark: Boolean) = execute(WebviewHtml.themeScript(vars, dark))

    fun openDevTools() = browser.openDevtools()

    override fun dispose() {
        synchronized(lock) { queue.clear() }
    }

    private fun execute(script: String) {
        synchronized(lock) {
            if (!loaded) {
                queue.add(script)
                return
            }
        }
        browser.cefBrowser.executeJavaScript(script, WebviewHtml.INDEX_URL, 0)
    }

    private fun markLoaded() {
        val pending = synchronized(lock) {
            loaded = true
            ArrayList(queue).also { queue.clear() }
        }
        for (script in pending) browser.cefBrowser.executeJavaScript(script, WebviewHtml.INDEX_URL, 0)
        onLoaded()
    }

    private fun handleQuery(request: String) {
        val parsed = runCatching { JsonParser.parseString(request).asJsonObject }.getOrNull() ?: return
        val payload = parsed.get("payload")
        when (parsed.get("kind")?.asString) {
            "postMessage" -> if (payload != null && !payload.isJsonNull) onMessage(payload)
            "setState" -> state = payload?.takeIf { !it.isJsonNull }
        }
    }

    private inner class RequestHandler : CefRequestHandlerAdapter() {
        override fun onBeforeBrowse(
            browser: CefBrowser?,
            frame: CefFrame?,
            request: CefRequest,
            userGesture: Boolean,
            isRedirect: Boolean,
        ): Boolean = !request.url.startsWith(WebviewHtml.ORIGIN + "/")

        override fun getResourceRequestHandler(
            browser: CefBrowser?,
            frame: CefFrame?,
            request: CefRequest,
            isNavigation: Boolean,
            isDownload: Boolean,
            requestInitiator: String?,
            disableDefaultHandling: BoolRef?,
        ): CefResourceRequestHandler = ResourceRequestHandler()
    }

    private inner class ResourceRequestHandler : CefResourceRequestHandlerAdapter() {
        override fun onBeforeResourceLoad(browser: CefBrowser?, frame: CefFrame?, request: CefRequest): Boolean {
            val allowed = request.url.startsWith(WebviewHtml.ORIGIN + "/")
            if (!allowed) LOG.info("Blocked request to ${request.url}")
            return !allowed
        }

        override fun getResourceHandler(browser: CefBrowser?, frame: CefFrame?, request: CefRequest): CefResourceHandler {
            val path = request.url.removePrefix(WebviewHtml.ORIGIN + "/").substringBefore('?').substringBefore('#')
            return when (path) {
                "index.html" -> StaticResource(pageHtml.toByteArray(Charsets.UTF_8), "text/html")
                "webview.js" -> StaticResource(bundled("webview.js"), "text/javascript")
                "webview.css" -> StaticResource(bundled("webview.css"), "text/css")
                else -> StaticResource(null, "text/plain")
            }
        }
    }

    companion object {
        private val LOG = logger<WebviewPanel>()

        private fun bundled(name: String): ByteArray? =
            WebviewPanel::class.java.getResourceAsStream("/packageawy/$name")?.use { it.readBytes() }
    }
}
