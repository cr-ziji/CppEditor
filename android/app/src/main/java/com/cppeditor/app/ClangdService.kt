package com.cppeditor.app

import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * clangd LSP 进程：纯管道。只负责拆帧（Content-Length + UTF-8 body）、转发原始
 * JSON-RPC 消息到渲染进程，以及对外发布 status / log 事件。JSON-RPC 会话完全由
 * 渲染进程（web/renderer.js 的 jsonrpc 连接）驱动。
 *
 * 事件（与 Electron 版 main.js 完全一致）：
 *   lsp:message  —— clangd 原始消息对象
 *   lsp:status   —— { state: 'starting'|'running'|'error'|'exited', message, code }
 *   lsp:log      —— 纯文本行（JSON 字符串字面量）
 */
class ClangdService(
    private val toolchain: ToolchainService,
    private val files: FilesService,
    private val settings: SettingsService,
) {
    private var proc: Process? = null
    private var writer: java.io.OutputStream? = null
    private val queue = LinkedBlockingQueue<String>()
    private var writeThread: Thread? = null
    private var readerThread: Thread? = null
    @Volatile private var running = false
    @Volatile private var toolchainResetting = false
    @Volatile private var startSeq = 0

    fun start(): JSONObject {
        stop()
        if (!toolchain.clangdReady()) {
            status("error", "clangd 不可用，请确认已安装工具链")
            return errorResult("clangd 不可用，请确认已安装工具链")
        }
        val seq = ++startSeq
        val args = mutableListOf(toolchain.clangdPath())
        args += clangdFlags()
        val pb = ProcessBuilder(args)
        pb.environment().putAll(toolchain.runEnv())
        val p = try {
            pb.start()
        } catch (e: Exception) {
            android.util.Log.e("ClangdService", "start failed: ${e.message}", e)
            status("error", "clangd 启动失败: ${e.message}")
            return errorResult("clangd 启动失败: ${e.message}")
        }
        proc = p
        writer = p.outputStream
        running = true

        val wt = Thread { writeLoop() }
        wt.isDaemon = true
        wt.start()
        writeThread = wt

        val rt = Thread { readLoop() }
        rt.isDaemon = true
        rt.start()
        readerThread = rt

        val watcher = Thread {
            val stderrBuf = StringBuilder()
            try {
                val errReader = p.errorStream.bufferedReader(StandardCharsets.UTF_8)
                while (running) {
                    val line = errReader.readLine() ?: break
                    stderrBuf.appendLine(line)
                    log("[clangd] $line")
                }
            } catch (_: Exception) {}
            val code = p.waitFor()
            if (seq != startSeq) return@Thread
            if (running) {
                running = false
                val stderr = stderrBuf.toString().trim()
                val msg = "clangd 已退出(code=$code)"
                if (stderr.isNotEmpty()) log("[clangd] stderr: ${stderr.take(500)}")
                if (code != 0 && stderr.contains("CANNOT LINK") && !toolchainResetting) {
                    toolchainResetting = true
                    status("error", "工具链库损坏，正在重新解压...", code = code)
                    log("[clangd] detected link error, resetting toolchain...")
                    toolchain.resetAndReExtract { ok ->
                        toolchainResetting = false
                        if (ok) {
                            log("[clangd] toolchain re-extracted, restarting clangd...")
                            start()
                        } else {
                            status("error", "工具链重解压失败")
                        }
                    }
                } else {
                    status("exited", msg, code = code)
                }
            }
        }
        watcher.isDaemon = true
        watcher.start()

        status("starting", "正在启动 clangd...")

        return JSONObject()
            .put("ok", true)
            .put("clangdPath", toolchain.clangdPath())
            .put("fallbackFlags", org.json.JSONArray(fallbackFlags()))
            .put("offsetEncoding", "utf-16")
            .put("projectDir", files.projectDir?.absolutePath ?: files.projectsDir.absolutePath)
    }

    private fun errorResult(message: String): JSONObject {
        return JSONObject().put("ok", false).put("message", message)
    }

    /** 与 Electron 版 clangdFallbackFlags() 对齐：工具链头文件 + 警告级别 + 自定义编译参数 + 语言标准 */
    private fun fallbackFlags(): List<String> {
        val cs = settings.compileSettings()
        return toolchain.clangFlags() +
            warningFlags(cs.warningLevel) +
            splitArgs(cs.compilerCommand) +
            listOf("-std=" + cs.languageStandardCpp)
    }

    fun stop() {
        running = false
        try {
            proc?.destroy()
            runCatching { proc?.waitFor(400, TimeUnit.MILLISECONDS) }
            if (proc?.isAlive == true) runCatching { proc?.destroyForcibly() }
        } catch (_: Exception) {
        }
        runCatching { proc?.outputStream?.close() }
        runCatching { proc?.inputStream?.close() }
        runCatching { proc?.errorStream?.close() }
        proc = null
        writer = null
        writeThread?.interrupt()
        writeThread = null
        readerThread?.interrupt()
        readerThread = null
        queue.clear()
    }

    fun send(msg: JSONObject?) {
        if (msg == null) return
        if (!running || proc == null) return
        queue.offer(msg.toString())
    }

    private fun clangdFlags(): List<String> {
        return listOf(
            "--background-index",
            "--clang-tidy",
            "--header-insertion=never",
            "--completion-style=detailed",
            "--pch-storage=memory",
            "--log=error",
            "--offset-encoding=utf-16",
            "-j=2",
            "--compile-commands-dir=${files.projectDir?.absolutePath ?: files.projectsDir.absolutePath}",
        )
    }

    // --- 事件发布 ------------------------------------------------------------

    private fun status(state: String, message: String? = null, code: Int? = null) {
        val j = JSONObject().put("state", state)
        if (message != null) j.put("message", message)
        if (code != null) j.put("code", code)
        EventBus.post("lsp:status", j.toString())
    }

    private fun log(line: String) {
        EventBus.post("lsp:log", JSONStr.quote(line.trim()))
    }

    // --- 写入循环 ------------------------------------------------------------

    private fun writeLoop() {
        while (running) {
            val msg = try {
                queue.poll(500, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                break
            } ?: continue
            if (!running) break
            val b = msg.toByteArray(StandardCharsets.UTF_8)
            try {
                writer?.write("Content-Length: ${b.size}\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
                writer?.write(b)
                writer?.flush()
            } catch (_: Exception) {
                break
            }
        }
    }

    // --- 读循环 + LSP 拆帧 ---------------------------------------------------

    private fun readLoop() {
        val reader = proc?.inputStream?.bufferedReader(StandardCharsets.UTF_8) ?: return
        var remaining = 0
        var needBody = false
        try {
            while (running) {
                if (needBody) {
                    val body = CharArray(remaining)
                    var got = 0
                    while (got < remaining) {
                        val n = reader.read(body, got, remaining - got)
                        if (n < 0) return
                        got += n
                    }
                    remaining = 0
                    needBody = false
                    val text = String(body)
                    try {
                        val msg = JSONObject(text)
                        EventBus.post("lsp:message", msg.toString())
                    } catch (e: Exception) {
                        log("[clangd] JSON 解析失败: ${e.message}")
                    }
                } else {
                    val line = reader.readLine() ?: return
                    if (line.isEmpty()) {
                        needBody = remaining > 0
                        continue
                    }
                    if (line.startsWith("Content-Length:")) {
                        remaining = line.substringAfter(':').trim().toIntOrNull() ?: remaining
                    }
                }
            }
        } catch (_: Exception) {
        }
    }
}
