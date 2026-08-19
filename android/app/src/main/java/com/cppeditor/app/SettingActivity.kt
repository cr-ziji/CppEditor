package com.cppeditor.app

import android.content.res.Configuration
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject

class SettingActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var bridge: JsBridge? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Services.init(applicationContext)
        webView = WebView(this)
        webView.layoutParams = android.view.ViewGroup.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
        )
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.setSupportMultipleWindows(false)
        webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        val theme = try {
            val settings = JSONObject(Services.settings.load())
            settings.optJSONObject("editor")?.optString("theme", "dark") ?: "dark"
        } catch (_: Exception) { "dark" }
        val bgColor = if (theme == "light") 0xFFFAFAFA.toInt() else 0xFF1E1E1E.toInt()
        webView.setBackgroundColor(bgColor)
        window.decorView.setBackgroundColor(bgColor)
        setContentView(webView)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        val client = object : WebViewClientCompat() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return !(request.url.scheme == "https" && request.url.authority == "appassets.androidplatform.net")
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                loader.shouldInterceptRequest(request.url)
        }
        webView.webViewClient = client
        webView.addJavascriptInterface(bridge("setting"), "AndroidBridge")
        webView.loadUrl("https://appassets.androidplatform.net/assets/setting.html?theme=$theme")
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveOnLandscape()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyImmersiveOnLandscape()
    }

    override fun onDestroy() {
        super.onDestroy()
        Services.removeBridge("setting")
        webView.destroy()
    }

    private fun bridge(scope: String): JsBridge {
        val b = JsBridge(scope) { method, args, callbackId, resolve ->
            when (method) {
                "loadSettings" -> resolve(callbackId, Services.settings.load())
                "saveSettings" -> resolve(callbackId, Services.saveSettings(args.optJSONObject(0)))
                "closeSettingWindow" -> finish()
                else -> resolve(callbackId, errObject("未知方法: $method"))
            }
        }
        bridge = b
        b.evaluate = { js -> runOnUiThread { webView.evaluateJavascript(js, null) } }
        Services.setBridge(scope, b)
        return b
    }
}
