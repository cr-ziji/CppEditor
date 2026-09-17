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

        val compiler = if (isC) toolchain.binary("gcc-16")?.absolutePath ?: "gcc"
                       else toolchain.binary("g++-16")?.absolutePath ?: "g++"
        val objFile = File(f.parentFile, f.nameWithoutExtension + ".o")
        val env = toolchain.runEnv()

        // ── 第 1 步：编译到 .o ──
        val cArgs = mutableListOf<String>()
        cArgs += toolchain.compileFlags()
        cArgs += compileArgs(isC, settings)
        cArgs += f.absolutePath
        cArgs += "-c"
        cArgs += "-o"
        cArgs += objFile.absolutePath

        val compileRes = runProcess(compiler, cArgs, f.parentFile, env)
        Log.i("CompileService", "compile step code=${compileRes.code}")
        Log.i("CompileService", "compile cmd: $compiler args=$cArgs")
        if (compileRes.code != 0 || !objFile.isFile) {
            Log.e("CompileService", "compile stderr: ${compileRes.err.take(4000)}")
            Log.e("CompileService", "compile stdout: ${compileRes.out.take(2000)}")
            resolve(callbackId, JSONObject()
                .put("ok", false).put("stage", "compile")
                .put("stderr", compileRes.err).put("stdout", compileRes.out).toString())
            return
        }

        // ── 第 2 步：链接 ──
        // 找 lld 链接器：优先 nativeLibDir（SELinux 可执行）
        val ldExe = findLldLinker()
        if (ldExe == null) {
            resolve(callbackId, errObject("找不到链接器 lld"))
            objFile.delete()
            return
        }

        val linkArgs = mutableListOf<String>()
        linkArgs += "-flavor"
        linkArgs += "ld"
        linkArgs += "--sysroot=${toolchain.usr.absolutePath}"
        linkArgs += "-L${toolchain.usr.absolutePath}/lib"
        toolchain.nativeLibDir?.let { linkArgs += "-L${it.absolutePath}" }
        toolchain.gccLibDir()?.let { linkArgs += "-L${it.absolutePath}" }
        if (toolchain.abi == ToolchainService.Abi.ARM32) linkArgs += "-L/system/lib"
        else linkArgs += "-L/system/lib64"
        val usrLib = File(toolchain.usr, "lib")
        val crtBegin = File(usrLib, "crtbegin_dynamic.o")
        val crtEnd = File(usrLib, "crtend_android.o")
        if (crtBegin.isFile) linkArgs += crtBegin.absolutePath
        linkArgs += objFile.absolutePath
        if (!isC) { linkArgs += "-lc++"; linkArgs += "-lc++abi" }
        linkArgs += "-lc"
        linkArgs += "-lm"
        linkArgs += "-ldl"
        linkArgs += "-lgcc"
        if (crtEnd.isFile) linkArgs += crtEnd.absolutePath
        linkArgs += "-pie"
        linkArgs += "-o"
        linkArgs += exe.absolutePath
        val userLdArgs = linkerArgs(settings).filter { it != "-static-libgcc" }
        linkArgs += userLdArgs

        val linkRes = runProcess(ldExe.absolutePath, linkArgs, f.parentFile, env)
        Log.i("CompileService", "link step code=${linkRes.code} exe=$ldExe")
        Log.i("CompileService", "link args: $linkArgs")
        if (linkRes.err.isNotEmpty()) Log.e("CompileService", "link stderr: ${linkRes.err.take(2000)}")
        if (linkRes.code != 0 || !exe.isFile) {
            resolve(callbackId, JSONObject()
                .put("ok", false).put("stage", "compile")
                .put("stderr", linkRes.err + compileRes.err.ifEmpty { "" })
                .put("stdout", linkRes.out).toString())
            objFile.delete()
            return
        }
        objFile.delete()

        files.projectDir?.let { runCatching { writeCompileCommands(it, toolchain, settings) } }

        val runExe = ensureExeInternal(exe)
        files.syncProject()
        resolve(callbackId, JSONObject()
            .put("ok", true).put("stage", "compile")
            .put("warnings", compileRes.err.ifEmpty { "" })
            .put("executable", runExe.absolutePath).toString())
    }

    /** 找到可执行的 lld 链接器 */
    private fun findLldLinker(): File? {
        // nativeLibDir 里的 libldlld.so 可以执行（PackageManager SELinux 上下文）
        val native = toolchain.nativeLibDir
        if (native != null) {
            val f = File(native, "libldlld.so")
            if (f.isFile) return f
        }
        // 回退：usr/bin/ld.lld（适用于 SELinux 宽松的设备如 Android 9）
        val usrBin = File(toolchain.usr, "bin/ld.lld")
        if (usrBin.isFile) return usrBin
        return null
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
