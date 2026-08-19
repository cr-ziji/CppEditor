package com.cppeditor.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 生成 compile_commands.json，让 clangd 以与编译一致的参数索引项目 */
fun writeCompileCommands(projectDir: File, toolchain: ToolchainService, settings: SettingsService) {
    val sourceExts = setOf("c", "cpp")
    val files = projectDir.walkTopDown()
        .filter { it.isFile && sourceExts.contains(it.extension.lowercase()) }
        .take(1000)
        .toList()
    if (files.isEmpty()) return
    val entries = JSONArray()
    for (f in files) {
        val isC = f.extension.equals("c", true)
        val compiler = if (isC) "gcc" else "g++"
        val args = JSONArray().put(compiler)
        toolchain.clangFlags().forEach { args.put(it) }
        compileArgs(isC, settings).forEach { args.put(it) }
        args.put(f.absolutePath)
        entries.put(JSONObject()
            .put("directory", projectDir.absolutePath)
            .put("file", f.absolutePath)
            .put("arguments", args))
    }
    File(projectDir, "compile_commands.json").writeText(entries.toString())
}

/** 由设置拼出编译参数：语言标准 + 警告级别 + 自定义编译参数 */
fun compileArgs(isC: Boolean, settings: SettingsService): List<String> {
    val cs = settings.compileSettings()
    val args = mutableListOf("-std=" + (if (isC) cs.languageStandardC else cs.languageStandardCpp))
    args += warningFlags(cs.warningLevel)
    args += splitArgs(cs.compilerCommand)
    return args
}

/** 链接参数（放在编译命令末尾） */
fun linkerArgs(settings: SettingsService): List<String> {
    return splitArgs(settings.compileSettings().linkerCommand)
}

/** 警告级别 0-4 → 编译警告标志（与 Electron 版 WARNING_LEVELS 一致） */
private val WARNING_LEVELS = listOf(
    "-w",
    "-W",
    "-Wall",
    "-Wall -Wextra",
    "-Wall -Wextra -Wpedantic",
)

fun warningFlags(level: Int): List<String> {
    return splitArgs(WARNING_LEVELS.getOrElse(level) { WARNING_LEVELS[2] })
}

/** 把空格分隔的参数字符串拆成数组（支持单/双引号包裹的含空格参数） */
fun splitArgs(str: String): List<String> {
    if (str.isBlank()) return emptyList()
    val out = mutableListOf<String>()
    val re = Regex("\"([^\"]*)\"|'([^']*)'|(\\S+)")
    for (m in re.findAll(str)) {
        out.add(m.groupValues[1].ifNotEmpty() ?: m.groupValues[2].ifNotEmpty() ?: m.groupValues[3])
    }
    return out
}

private fun String.ifNotEmpty(): String? = if (isEmpty()) null else this

/** 执行外部命令，捕获 stdout/stderr，超时后杀进程 */
data class ProcResult(val code: Int, val out: String, val err: String)

fun runProcess(cmd: String, args: List<String>, cwd: File?, env: Map<String, String>?, timeoutMs: Long = 120_000): ProcResult {
    val pb = ProcessBuilder(listOf(cmd) + args)
    if (cwd != null && cwd.isDirectory) pb.directory(cwd)
    if (env != null) pb.environment().putAll(env)
    pb.redirectInput(ProcessBuilder.Redirect.PIPE)
    val p = try {
        pb.start().also { it.outputStream.close() }
    } catch (e: Exception) {
        return ProcResult(-1, "", "无法启动进程: ${e.message}")
    }
    val outBytes = java.io.ByteArrayOutputStream()
    val errBytes = java.io.ByteArrayOutputStream()
    val t1 = Thread { runCatching { p.inputStream.copyTo(outBytes) } }.apply { isDaemon = true; start() }
    val t2 = Thread { runCatching { p.errorStream.copyTo(errBytes) } }.apply { isDaemon = true; start() }
    val finished = try {
        p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
        false
    }
    if (!finished) {
        p.destroy()
        runCatching { p.destroyForcibly() }
        return ProcResult(-1, String(outBytes.toByteArray(), Charsets.UTF_8), String(errBytes.toByteArray(), Charsets.UTF_8) + "\n[超时]")
    }
    t1.join(2000)
    t2.join(2000)
    return ProcResult(p.exitValue(), String(outBytes.toByteArray(), Charsets.UTF_8), String(errBytes.toByteArray(), Charsets.UTF_8))
}
