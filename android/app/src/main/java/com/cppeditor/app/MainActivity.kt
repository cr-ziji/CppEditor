package com.cppeditor.app

import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var bridge: JsBridge? = null

    private val dirPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        Services.files.onFolderPicked(uri)
    }

    private val saveAsPicker = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        Services.files.onSaveAsPicked(uri)
    }

    private val storagePermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* granted or denied, we proceed either way */ }

    private val manageStorageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        // 返回后重新检查；如果仍然未授权，通知 WebView
        if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            webView.evaluateJavascript("window.editorAPI?.onStorageDenied?.()", null)
        }
    }

    private fun ensureStoragePermission() {
        if (Build.VERSION.SDK_INT >= 30) {
            if (!Environment.isExternalStorageManager()) {
                // 先尝试精确跳转到本应用的权限页
                try {
                    val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    manageStorageLauncher.launch(intent)
                } catch (_: Exception) {
                    // 部分 OEM ROM 不支持精确跳转，退回通用页
                    try {
                        val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                        manageStorageLauncher.launch(intent)
                    } catch (_: Exception) { }
                }
            }
        } else if (Build.VERSION.SDK_INT >= 23) {
            val perm = android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            storagePermLauncher.launch(perm)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Services.init(applicationContext)
        Services.files.registerPickerLauncher(dirPicker)
        Services.files.registerSaveAsLauncher(saveAsPicker)
        ensureStoragePermission()

        webView = object : WebView(this) {
            override fun performLongClick(): Boolean {
                // 完全屏蔽 WebView 原生长按文本选择菜单（Copy/Share/Select All）
                // JS 侧通过 touchstart/touchend 自行实现长按右键菜单
                return true
            }
        }
        webView.layoutParams = android.view.ViewGroup.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
        )
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.setSupportMultipleWindows(false)
        webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE

        // 从设置读取主题，WebView 背景与主题一致，避免白屏/黑屏闪烁
        val theme = try {
            val settings = JSONObject(Services.settings.load())
            settings.optJSONObject("editor")?.optString("theme", "dark") ?: "dark"
        } catch (_: Exception) { "dark" }
        val bgColor = themeBackgroundColor(theme)
        webView.setBackgroundColor(bgColor)

        // 屏蔽 WebView 原生长按文本弹出的系统选择菜单（英文 Copy/Share 等）。
        // 编辑器 / 文件树的长按菜单由 JS 侧自行实现，避免两个菜单叠加。
        webView.setOnLongClickListener { true }
        webView.isHapticFeedbackEnabled = false
        setContentView(webView)
        applyThemeBackground(theme)
        applySystemBarInsets()
        disableSystemBarContrastScrim()

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
        webView.addJavascriptInterface(bridge("main"), "AndroidBridge")

        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html?theme=$theme")
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveOnLandscape()
        // 从后台恢复时重新扫描文件树，同步外部修改
        Services.files.syncProject()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyImmersiveOnLandscape()
    }

    override fun onDestroy() {
        super.onDestroy()
        Services.clangd.stop()
        Services.removeBridge("main")
        webView.destroy()
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    private fun bridge(scope: String): JsBridge {
        val b = JsBridge(scope) { method, args, callbackId, resolve ->
            handle(method, args, callbackId, resolve)
        }
        bridge = b
        b.evaluate = { js -> runOnUiThread { webView.evaluateJavascript(js, null) } }
        Services.setBridge(scope, b)
        return b
    }

    private fun handle(method: String, args: JSONArray, callbackId: Int, resolve: (Int, String) -> Unit) {
        val files = Services.files
        val clangd = Services.clangd
        when (method) {
            "start" -> resolve(callbackId, clangd.start().toString())
            "stop" -> clangd.stop()
            "send" -> {
                val msg = args.optJSONObject(0)
                if (msg != null) clangd.send(msg)
            }
            "restart" -> clangd.start()
            "toolchainStatus" -> resolve(
                callbackId,
                JSONObject()
                    .put("ready", Services.toolchain.ready())
                    .put("abi", Services.toolchain.abi.name)
                    .toString(),
            )
            "loadProject" -> resolve(callbackId, files.loadProject())
            "openProjectFolder" -> files.requestOpenProjectFolder(callbackId, resolve)
            "chooseDirectory" -> files.requestChooseDirectory(callbackId, resolve)
            "readFile" -> resolve(callbackId, files.readFile(args.optString(0)))
            "saveFile" -> resolve(callbackId, files.saveFile(args.optString(0), args.optString(1)))
            "saveAs" -> Services.files.requestSaveAs(args.optString(0), args.optString(1), callbackId, resolve)
            "getSaved" -> resolve(callbackId, files.getSaved())
            "runFile" -> Services.compile.runFile(args.optString(0), callbackId, resolve)
            "startRun" -> { Services.compile.startRun(args.optString(0)); resolve(callbackId, "{}") }
            "sendInput" -> { Services.compile.sendInput(args.optString(0)); resolve(callbackId, "{}") }
            "stopRun" -> { Services.compile.stopRun(); resolve(callbackId, "{}") }
            "readClipboardText" -> {
                val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                resolve(callbackId, JSONObject().put("text", cm.primaryClip?.getItemAt(0)?.text ?: "").toString())
            }
            "writeClipboardText" -> {
                val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("cppeditor", args.optString(0)))
            }
            "loadSettings" -> resolve(callbackId, Services.settings.load())
            "saveSettings" -> resolve(callbackId, Services.saveSettings(args.optJSONObject(0)))
            "updateThemeColors" -> {
                val theme = args.optString(0, "dark")
                runOnUiThread { applyThemeBackground(theme) }
                resolve(callbackId, "{}")
            }
            "minimizeWindow" -> moveTaskToBack(true)
            "maximizeWindow", "unmaximizeWindow" -> { /* 移动端无需窗口控制 */ }
            "closeWindow" -> finish()
            "openSettingWindow" -> {
                val intent = android.content.Intent(this, SettingActivity::class.java)
                startActivity(intent)
            }
            "closeSettingWindow" -> { /* 仅设置窗口有效 */ }
            "resetToolchain" -> {
                Services.toolchain.resetAndReExtract { ok ->
                    resolve(callbackId, """{"ok":$ok}""")
                }
            }
            else -> {
                if (method.startsWith("tree")) {
                    val paths = args.optJSONArray(0) ?: JSONArray()
                    val rest = args
                    when (method) {
                        "treeCopy", "treeCut", "treeDelete" -> resolve(callbackId, files.treeOp(method, paths))
                        "treePaste" -> resolve(callbackId, files.treeOp(method, rest))
                        "treeRename" -> resolve(callbackId, files.treeOp(method, rest))
                        "treeReveal" -> {
                            val path = args.optString(0)
                            val f = if (path.isNotEmpty()) java.io.File(path) else null
                            if (f != null && f.exists()) {
                                try {
                                    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW)
                                    val target = if (f.isDirectory) f else f.parentFile ?: f
                                    val docPath = target.absolutePath.removePrefix("/storage/emulated/0").removePrefix("/")
                                    val docUri = android.net.Uri.parse(
                                        "content://com.android.externalstorage.documents/document/primary%3A$docPath"
                                    )
                                    intent.setDataAndType(docUri, "vnd.android.document/directory")
                                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                                    startActivity(intent)
                                } catch (_: Exception) {
                                    try {
                                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("content://com.android.externalstorage.documents/"))
                                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                                        startActivity(intent)
                                    } catch (_: Exception) { }
                                }
                            }
                            resolve(callbackId, """{"ok":true}""")
                        }
                        "treeOpenFile" -> {
                            val path = args.optString(0)
                            val f = if (path.isNotEmpty()) java.io.File(path) else null
                            if (f != null && f.isFile && f.exists()) {
                                try {
                                    val uri = android.net.Uri.fromFile(f)
                                    val mime = contentResolver.getType(uri) ?: "*/*"
                                    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW)
                                    intent.setDataAndType(uri, mime)
                                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                                    startActivity(intent)
                                } catch (_: Exception) {
                                    try {
                                        val uri = android.net.Uri.fromFile(f)
                                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, uri)
                                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                                        startActivity(intent)
                                    } catch (_: Exception) { }
                                }
                            }
                            resolve(callbackId, """{"ok":true}""")
                        }
                        "treeCopyPath" -> {
                            val path = args.optString(0)
                            if (path.isNotEmpty()) {
                                val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                val clip = android.content.ClipData.newPlainText("path", path)
                                cm.setPrimaryClip(clip)
                            }
                            resolve(callbackId, """{"ok":true}""")
                        }
                        "treeCreateFile" -> resolve(callbackId, files.treeOp(method, rest))
                        "treeCreateDir" -> resolve(callbackId, files.treeOp(method, rest))
                        else -> resolve(callbackId, errObject("未知方法: $method"))
                    }
                } else {
                    resolve(callbackId, errObject("未知方法: $method"))
                }
            }
        }
    }
}
