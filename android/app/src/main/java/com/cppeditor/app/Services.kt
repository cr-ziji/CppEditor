package com.cppeditor.app

import android.content.Context

/**
 * 全局服务容器：Electron 版 main.js 的 IPC 能力在 Android 端由这些服务实现。
 * 两个 WebView（主窗口 / 设置窗口）共用同一份服务，事件经 EventBus 分发。
 */
object Services {
    lateinit var context: Context
    lateinit var toolchain: ToolchainService
    lateinit var settings: SettingsService
    lateinit var files: FilesService
    lateinit var clangd: ClangdService
    lateinit var compile: CompileService

    private val bridges = java.util.concurrent.ConcurrentHashMap<String, JsBridge>()
    private val subscribedScopes = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun init(ctx: Context) {
        if (::toolchain.isInitialized) return
        context = ctx.applicationContext
        toolchain = ToolchainService(context)
        settings = SettingsService(context)
        files = FilesService(context, toolchain, settings)
        clangd = ClangdService(toolchain, files, settings)
        compile = CompileService(toolchain, files, settings)
        toolchain.ensureExtracted()
    }

    /** 注册某 WebView 的桥，并把 EventBus 事件转发为该页面 window.__bridgeEvent */
    fun setBridge(scope: String, b: JsBridge) {
        bridges[scope] = b
        if (subscribedScopes.add(scope)) {
            EventBus.subscribe { channel, payload ->
                val br = bridges[scope] ?: return@subscribe
                runCatching {
                    br.evaluate?.invoke("__bridgeEvent(${JSONStr.quote(channel)}, ${JSONStr.quote(payload)})")
                }
            }
        }
    }

    fun removeBridge(scope: String) {
        bridges.remove(scope)
    }

    /** 保存设置；若编译设置变更则重建 compile_commands.json 并广播重启（同 Electron 版） */
    fun saveSettings(patch: org.json.JSONObject?): String {
        val saved = settings.save(patch)
        if (patch?.has("compile") == true) {
            val pd = files.projectDir
            if (pd != null) {
                writeCompileCommands(pd, toolchain, settings)
                EventBus.post(
                    "lsp:compile-db-updated",
                    JSONStr.quote(java.io.File(pd, "compile_commands.json").absolutePath),
                )
            }
            EventBus.post("lsp:restart", "{}")
        }
        return saved
    }
}

/** 简单事件总线：主/设置两个 WebView 桥都订阅，收到后转发给各自页面 */
object EventBus {
    private val listeners = mutableListOf<(channel: String, payload: String) -> Unit>()

    @Synchronized
    fun subscribe(l: (channel: String, payload: String) -> Unit) {
        listeners.add(l)
    }

    @Synchronized
    fun post(channel: String, payload: String) {
        for (l in listeners) {
            runCatching { l(channel, payload) }
        }
    }
}

fun errObject(message: String): String {
    return "{\"ok\":false,\"message\":${JSONStr.quote(message)}}"
}

/** JSON 字符串字面量转义 */
object JSONStr {
    fun quote(s: String): String {
        return org.json.JSONObject.quote(s)
    }
}
