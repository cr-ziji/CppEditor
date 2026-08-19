package com.cppeditor.app

import android.webkit.JavascriptInterface
import org.json.JSONArray

/**
 * JS 桥：window.AndroidBridge 注入 WebView。
 * 契约见 web/platform.js：
 *   ready()                                    —— 前端探测
 *   call(method, JSON.stringify(argsArray), id) —— 参数为「位置参数数组」的 JSON 字符串
 *   回调：window.__bridgeResult(id, json)（两参数）、window.__bridgeEvent(channel, json)
 */
class JsBridge(
    private val scope: String,
    private val handler: (method: String, args: JSONArray, callbackId: Int, resolve: (Int, String) -> Unit) -> Unit,
) {
    @Volatile
    var evaluate: ((String) -> Unit)? = null

    @JavascriptInterface
    fun ready(): Boolean = true

    @JavascriptInterface
    fun call(method: String, argsJson: String?, callbackId: Int) {
        val args = try {
            argsJson?.let { JSONArray(it) } ?: JSONArray()
        } catch (_: Exception) {
            JSONArray()
        }
        val resolve: (Int, String) -> Unit = { id, json ->
            val code = "__bridgeResult($id, ${JSONStr.quote(json)})"
            runOnMain { evaluate?.invoke(code) }
        }
        try {
            handler(method, args, callbackId, resolve)
        } catch (e: Exception) {
            if (callbackId != -1) resolve(callbackId, errObject("处理出错: ${e.message}"))
        }
    }

    private fun runOnMain(r: () -> Unit) {
        android.os.Handler(android.os.Looper.getMainLooper()).post(r)
    }
}
