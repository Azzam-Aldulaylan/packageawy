package io.github.azzamaldulaylan.packageawy.webview

import org.cef.callback.CefCallback
import org.cef.handler.CefResourceHandlerAdapter
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse

/**
 * Serves one in-memory response to JCEF. A null body is a 404. Extends the
 * adapter because newer JCEF adds methods to the interface. Their defaults
 * fall back to the methods overridden here.
 */
class StaticResource(private val body: ByteArray?, private val mimeType: String) : CefResourceHandlerAdapter() {
    private var offset = 0

    override fun processRequest(request: CefRequest, callback: CefCallback): Boolean {
        callback.Continue()
        return true
    }

    override fun getResponseHeaders(response: CefResponse, responseLength: IntRef, redirectUrl: StringRef) {
        response.mimeType = mimeType
        response.setHeaderByName("Cache-Control", "no-store", true)
        if (body == null) {
            response.status = 404
            responseLength.set(0)
        } else {
            response.status = 200
            responseLength.set(body.size)
        }
    }

    override fun readResponse(dataOut: ByteArray, bytesToRead: Int, bytesRead: IntRef, callback: CefCallback): Boolean {
        val data = body ?: return false.also { bytesRead.set(0) }
        val count = minOf(bytesToRead, data.size - offset)
        if (count <= 0) {
            bytesRead.set(0)
            return false
        }
        System.arraycopy(data, offset, dataOut, 0, count)
        offset += count
        bytesRead.set(count)
        return true
    }
}
