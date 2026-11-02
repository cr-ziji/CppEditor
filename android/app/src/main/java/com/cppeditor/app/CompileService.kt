package com.cppeditor.app

import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.OutputStream

class CompileService(
    private val toolchain: ToolchainService,
    private val files: FilesService,
    private val settings: SettingsService,
) {
    @Volatile private var currentProcess: Process? = null
    @Volatile private var stdinStream: OutputStream? = null

    // ── 编译（只编译不运行）───────────────────────────────────
    fun runFile(filePath: String, callbackId: Int, resolve: (Int, String) -> Unit) {
        Thread {
            try {
                doCompile(filePath, callbackId, resolve)
            } catch (e: Exception) {
                resolve(callbackId, errObject("编译异常: ${e.message}"))
            }
        }.start()
    }

    private fun doCompile(filePath: String, callbackId: Int, resolve: (Int, String) -> Unit) {
        val f = File(filePath)
        if (!f.isFile) { resolve(callbackId, errObject("文件不存在: $filePath")); return }
        if (!toolchain.compilerReady()) { resolve(callbackId, errObject("编译器不可用，请确认已安装工具链")); return }

        val isC = f.extension.equals("c", true)
        val exe = File(f.parentFile, f.nameWithoutExtension)
        exe.delete()

        val compiler = toolchain.compiler(isC)
        if (compiler == null) { resolve(callbackId, errObject("找不到编译器 ${toolchain.abi.triple}-g++")); return }
        val env = toolchain.runEnv()

        // 真正的 g++（GCC 16）单步完成编译 + 链接：
        // 驱动本身由 linker64 加载（filesDir 不可 exec），内部 cc1plus/as/collect2
        // 靠 gccFlags() 里的 -wrapper /system/bin/linker64 走同一条路径，
        // collect2 最后 exec 的 ld 则由 jniLibs 里的 libldbfd.so 提供。
        val args = mutableListOf<String>()
        args += toolchain.gccFlags()
        args += compileArgs(isC, settings)
        args += listOf("-fPIE", "-pie")
        // 静态链接 C++ 运行时（libstdc++ / libgcc），避免设备端缺库
        args += listOf("-static-libstdc++", "-static-libgcc")
        args += f.absolutePath
        args += "-o"
        args += exe.absolutePath
        args += linkerArgs(settings)

        Log.i("CompileService", "compile cmd: ${toolchain.linkerPath()} ${compiler.absolutePath}")
        Log.i("CompileService", "compile args: $args")
        val res = runProcess(
            toolchain.linkerPath(),
            listOf(compiler.absolutePath) + args,
            f.parentFile, env, timeoutMs = 300_000,
        )
        Log.i("CompileService", "compile code=${res.code}")
        if (res.err.isNotEmpty()) Log.w("CompileService", "compile stderr: ${res.err.take(2000)}")
        if (res.code != 0 || !exe.isFile) {
            resolve(callbackId, JSONObject()
                .put("ok", false).put("stage", "compile")
                .put("stderr", res.err).put("stdout", res.out).toString())
            return
        }

        files.projectDir?.let { runCatching { writeCompileCommands(it, toolchain, settings) } }

        val runExe = ensureExeInternal(exe)
        files.syncProject()
        resolve(callbackId, JSONObject()
            .put("ok", true).put("stage", "compile")
            .put("warnings", res.err.ifEmpty { "" })
            .put("executable", runExe.absolutePath).toString())
    }

    /** 确保可执行文件在 app 内部存储（SELinux 可执行） */
    private fun ensureExeInternal(exe: File): File {
        val appFiles = Services.context.filesDir
        if (!exe.canonicalPath.startsWith(appFiles.canonicalPath)) {
            val runDir = File(appFiles, "exec").apply { mkdirs() }
            val dest = File(runDir, exe.name)
            exe.copyTo(dest, overwrite = true)
            dest.setExecutable(true, false)
            return dest
        }
        return exe
    }

    // ── 交互式运行（流式 stdout/stderr + stdin 输入）─────────────
    fun startRun(exePath: String) {
        stopRun()
        Thread {
            try {
                val useLinker = android.os.Build.VERSION.SDK_INT >= 30
                val cmd = if (useLinker) {
                    val linker = when (toolchain.abi) {
                        ToolchainService.Abi.ARM32 -> "/system/bin/linker"
                        ToolchainService.Abi.ARM64 -> "/system/bin/linker64"
                    }
                    listOf(linker, exePath)
                } else {
                    listOf(exePath)
                }
                val pb = ProcessBuilder(cmd)
                val env = toolchain.runEnv()
                pb.environment().putAll(env)
                pb.redirectErrorStream(false)
                Log.i("CompileService", "startRun cmd=$cmd LD=${env["LD_LIBRARY_PATH"]}")
                val p = pb.start()
                currentProcess = p
                stdinStream = p.outputStream

                EventBus.post("run:started", "{}")

                val tOut = Thread {
                    runCatching {
                        val buf = ByteArray(4096)
                        var n: Int
                        while (p.inputStream.read(buf).also { n = it } != -1) {
                            val chunk = String(buf, 0, n, Charsets.UTF_8)
                            EventBus.post("run:stdout", JSONObject().put("data", chunk).toString())
                        }
                    }
                }.apply { isDaemon = true; start() }

                val tErr = Thread {
                    runCatching {
                        val buf = ByteArray(4096)
                        var n: Int
                        while (p.errorStream.read(buf).also { n = it } != -1) {
                            val chunk = String(buf, 0, n, Charsets.UTF_8)
                            EventBus.post("run:stderr", JSONObject().put("data", chunk).toString())
                        }
                    }
                }.apply { isDaemon = true; start() }

                val t0 = System.currentTimeMillis()
                val exitCode = p.waitFor()
                val elapsed = System.currentTimeMillis() - t0
                tOut.join(2000)
                tErr.join(2000)

                EventBus.post("run:exit", JSONObject()
                    .put("code", exitCode)
                    .put("time", elapsed).toString())
            } catch (e: Exception) {
                Log.e("CompileService", "startRun failed: ${e.message}", e)
                EventBus.post("run:exit", JSONObject()
                    .put("code", -1).put("time", 0)
                    .put("error", e.message ?: "unknown").toString())
            } finally {
                currentProcess = null
                stdinStream = null
            }
        }.start()
    }

    fun sendInput(text: String) {
        val os = stdinStream ?: return
        Thread {
            runCatching {
                os.write(text.toByteArray(Charsets.UTF_8))
                os.flush()
            }
        }.start()
    }

    fun stopRun() {
        currentProcess?.let { p ->
            runCatching {
                stdinStream?.close()
                p.destroy()
                Thread.sleep(200)
                if (p.isAlive) p.destroyForcibly()
            }
        }
        currentProcess = null
        stdinStream = null
    }
}
