package io.github.azzamaldulaylan.packageawy.webview

import com.google.gson.JsonElement
import io.github.azzamaldulaylan.packageawy.rpc.JsonRpcConnection
import java.security.SecureRandom
import java.util.Base64

/**
 * The page the tool window loads. The same rules as the VS Code panel: a
 * fresh nonce per load, no `unsafe-inline` or `unsafe-eval`, nothing loadable
 * outside [ORIGIN]. The only inline script is the nonce-tagged API shim.
 */
object WebviewHtml {
    const val ORIGIN = "https://packageawy.local"
    const val INDEX_URL = "$ORIGIN/index.html"

    /**
     * @param sendToHost a JS expression that sends the string in the variable `request` to the IDE.
     * @param initialState the state the last `setState` stored, or null.
     */
    fun build(
        sendToHost: String,
        initialState: JsonElement?,
        themeCss: String,
        dark: Boolean,
        performanceDebug: Boolean,
        nonce: String = newNonce(),
    ): String {
        val csp = listOf(
            "default-src 'none'",
            "script-src 'nonce-$nonce'",
            "style-src $ORIGIN 'nonce-$nonce'",
            "img-src $ORIGIN data:",
            "font-src $ORIGIN",
        ).joinToString("; ")
        val themeClass = if (dark) "vscode-dark" else "vscode-light"
        return """<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="$csp" />
    <style nonce="$nonce">$themeCss</style>
    <style nonce="$nonce">$BASE_CSS</style>
    <link rel="stylesheet" href="$ORIGIN/webview.css" />
    <title>Packageawy</title>
  </head>
  <body class="$themeClass" data-performance-debug="$performanceDebug">
    <div id="root"></div>
    <script nonce="$nonce">${shim(sendToHost, initialState)}</script>
    <script nonce="$nonce" src="$ORIGIN/webview.js"></script>
  </body>
</html>"""
    }

    /** Defines `acquireVsCodeApi` like VS Code's webview host, plus the hooks the IDE calls. */
    fun shim(sendToHost: String, initialState: JsonElement?): String {
        val state = if (initialState == null) "undefined" else jsLiteral(initialState)
        return """(function () {
  var state = $state;
  var acquired = false;
  function send(kind, payload) {
    var request = JSON.stringify({ kind: kind, payload: payload === undefined ? null : payload });
    $sendToHost;
  }
  window.acquireVsCodeApi = function () {
    if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
    acquired = true;
    return Object.freeze({
      postMessage: function (message) { send('postMessage', message); },
      getState: function () { return state; },
      setState: function (next) { state = next; send('setState', next); return next; }
    });
  };
  window.__packageawyReceive = function (message) {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  };
  window.__packageawyTheme = function (vars, dark) {
    var root = document.documentElement.style;
    root.setProperty('color-scheme', dark ? 'dark' : 'light');
    Object.keys(vars).forEach(function (name) { root.setProperty('--vscode-' + name, vars[name]); });
    document.body.classList.toggle('vscode-dark', dark);
    document.body.classList.toggle('vscode-light', !dark);
  };
})();"""
    }

    /** Script that delivers one host message to the page. */
    fun receiveScript(message: JsonElement): String = "window.__packageawyReceive(${jsLiteral(message)});"

    fun themeScript(vars: Map<String, String>, dark: Boolean): String =
        "window.__packageawyTheme && window.__packageawyTheme(${jsLiteral(JsonRpcConnection.toJson(vars))}, $dark);"

    /** JSON is valid JavaScript. `<` is escaped so the text can never close a script element. */
    fun jsLiteral(value: JsonElement): String =
        JsonRpcConnection.GSON.toJson(value)
            .replace("<", "\\u003c")
            .replace(" ", "\\u2028")
            .replace(" ", "\\u2029")

    fun newNonce(): String {
        val bytes = ByteArray(16)
        RANDOM.nextBytes(bytes)
        return Base64.getEncoder().encodeToString(bytes)
    }

    private val RANDOM = SecureRandom()

    // VS Code gives every webview these defaults. The dashboard stylesheet builds on them.
    private const val BASE_CSS = "html{scrollbar-color:var(--vscode-scrollbarSlider-background) transparent}" +
        "body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);" +
        "font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}" +
        "a{color:var(--vscode-textLink-foreground)}a:hover{color:var(--vscode-textLink-activeForeground)}" +
        "code{font-family:var(--vscode-editor-font-family);color:var(--vscode-textPreformat-foreground)}" +
        "::-webkit-scrollbar{width:10px;height:10px}" +
        "::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background)}" +
        "::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}"
}
