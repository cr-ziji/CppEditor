package com.cppeditor.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.util.Log
import org.json.JSONObject
import java.io.File

/** 目标 Android API 等级（minSdk = 24），决定使用包内 <triple>24 sysroot */
const val ANDROID_API_LEVEL = 24

/** 工具链内容版本；与 zip 内 version.txt 不一致时整体重新解压 */
private const val TOOLCHAIN_VERSION = "gcc-16.2.1-2"

/**
 * 管理打包在 assets/toolchain-<abi>.zip 中的工具链：真正的 GCC 16（g++ + libstdc++）、
 * clangd（仅用于编辑器 LSP）、头文件与系统库。
 *
 * 关键点：
 *  - Android 10+ 禁止执行应用数据目录（filesDir）里的文件，因此 GCC 的驱动/cc1/as 等
 *    通过 `/system/bin/linker64 <程序>` 方式加载运行（mmap 而非 execve），
 *    GCC 内部再通过 `-wrapper /system/bin/linker64` 让 cc1/cc1plus/as/collect2 也走同一路径。
 *  - 只有被 collect2 直接 exec 的 `ld` 必须放在 jniLibs（nativeLibraryDir 可执行），
 *    由 symlinks.json 里的 `@native:` 条目解析成符号链接。
 */
class ToolchainService(private val ctx: Context) {

    enum class Abi(
        val zipAsset: String,
        /** 交叉工具链 triple，也是包内 <triple>/ sysroot 目录名 */
        val triple: String,
        /** clangd / clang 侧使用的目标 triple（带 API 版本） */
        val clangTarget: String,
    ) {
        ARM64("toolchain-arm64-v8a.zip", "aarch64-unknown-linux-android", "aarch64-linux-android"),
        ARM32("toolchain-armeabi-v7a.zip", "armv7-unknown-linux-androideabi", "armv7a-linux-androideabi");

        /** 带 API 后缀的 sysroot 目录名，如 aarch64-unknown-linux-android24 */
        val sysDir: String get() = triple + ANDROID_API_LEVEL

        fun matches(deviceAbi: String): Boolean =
            (this == ARM64 && deviceAbi == "arm64-v8a") ||
                (this == ARM32 && (deviceAbi == "armeabi-v7a" || deviceAbi == "armeabi"))

        companion object {

            /** 优先选与设备匹配且资产存在的包；都不匹配（如瘦身包装错设备）则退回任意可用资产 */
            fun detect(ctx: Context): Abi {
                val primary = try {
                    val f = ctx.applicationInfo.javaClass.getField("primaryCpuAbi")
                    f.get(ctx.applicationInfo) as? String
                } catch (_: Exception) { null }
                if (primary != null) {
                    for (abi in entries) {
                        if (abi.matches(primary) && assetExists(ctx, abi.zipAsset)) return abi
                    }
                }
                for (d in Build.SUPPORTED_ABIS) {
                    for (abi in entries) {
                        if (abi.matches(d) && assetExists(ctx, abi.zipAsset)) return abi
                    }
                }
                for (abi in entries) if (assetExists(ctx, abi.zipAsset)) return abi
                return ARM64
            }

            private fun assetExists(ctx: Context, name: String): Boolean =
                runCatching { ctx.assets.open(name).close(); true }.getOrDefault(false)
        }
    }

    val abi: Abi = Abi.detect(ctx)

    val root: File get() = File(ctx.filesDir, "toolchain")
    val usr: File get() = File(root, "usr")

    /** nativeLibraryDir 由 PackageManager 在安装时解压 jniLibs 得到（SELinux 允许执行） */
    val nativeLibDir: File? by lazy {
        val dir = File(ctx.applicationInfo.nativeLibraryDir)
        if (dir.isDirectory && dir.listFiles()?.isNotEmpty() == true) dir else null
    }

    /** 需要从 nativeLibraryDir 取的程序名 → jniLibs 文件名 */
    private val nativeExeNames = mapOf(
        "clangd" to "libclangd.so",
        "ld" to "libldbfd.so",
    )

    /** 用来加载 filesDir 内可执行文件的系统动态链接器 */
    fun linkerPath(): String =
        if (abi == Abi.ARM64) "/system/bin/linker64" else "/system/bin/linker"

    private val assetZip: String get() = abi.zipAsset

    private fun versionOk(): Boolean {
        val f = File(root, "version.txt")
        return f.isFile && runCatching { f.readText().trim() }.getOrNull() == TOOLCHAIN_VERSION
    }

    /** 工具链是否已解压就绪（版本标记一致 + 关键文件完整） */
    fun ready(): Boolean = versionOk() && verifyExtracted()

    /**
     * 首次启动在后台线程解压工具链，避免主线程长时间阻塞导致启动卡死 / ANR。
     * 期间广播 toolchain:progress（{"done":n}），完成广播 toolchain:ready（"true"/"false"）。
     */
    fun ensureExtracted(onDone: (Boolean) -> Unit = {}) {
        if (ready()) {
            onDone(true)
            return
        }
        Thread {
            if (root.exists() && !versionOk()) {
                // 旧版本（clang 工具链或未完成解压）残留，整体清掉避免文件混杂
                runCatching { root.deleteRecursively() }
            }
            val ok = prepare()
            EventBus.post("toolchain:ready", ok.toString())
            onDone(ok)
        }.apply { isDaemon = true }.start()
    }

    fun resetAndReExtract(onDone: (Boolean) -> Unit = {}) {
        Thread {
            try {
                if (root.exists()) root.deleteRecursively()
                Log.i("ToolchainService", "toolchain deleted, re-extracting...")
            } catch (e: Exception) {
                Log.w("ToolchainService", "delete toolchain failed: ${e.message}")
            }
            val ok = prepare()
            EventBus.post("toolchain:ready", ok.toString())
            onDone(ok)
        }.apply { isDaemon = true }.start()
    }

    private fun prepare(): Boolean = runCatching {
        unzipAssets { done -> if (done % 25 == 0) postToolchain("toolchain:progress", """{"done":$done}""") }
        applySymlinks()
        makeExecutable()
        verifyExtracted()
    }.getOrDefault(false)

    private fun verifyExtracted(): Boolean {
        val critical = listOf(
            "usr/bin/${abi.triple}-g++",
            "usr/lib/libestdc++.so",
        )
        for (rel in critical) {
            val f = File(root, rel)
            if (!f.isFile) {
                Log.w("ToolchainService", "missing: $rel")
                return false
            }
            val header = ByteArray(4)
            java.io.FileInputStream(f).use {
                var off = 0
                while (off < 4) {
                    val n = it.read(header, off, 4 - off)
                    if (n <= 0) break
                    off += n
                }
            }
            if (header[0] != 0x7f.toByte() || header[1] != 'E'.code.toByte() ||
                header[2] != 'L'.code.toByte() || header[3] != 'F'.code.toByte()) {
                Log.e("ToolchainService", "invalid ELF in $rel (${f.length()} bytes)")
                return false
            }
        }
        val cc1plus = File(usr, "libexec/gcc/${abi.triple}/16/cc1plus")
        if (!cc1plus.isFile) {
            Log.w("ToolchainService", "missing: cc1plus")
            return false
        }
        return true
    }

    private fun postToolchain(channel: String, payload: String) {
        Handler(Looper.getMainLooper()).post { EventBus.post(channel, payload) }
    }

    private fun lexists(f: File): Boolean =
        runCatching { Os.lstat(f.absolutePath); true }.getOrDefault(false)

    /**
     * zip 里不含符号链接，symlinks.json 记录「链接路径 → 目标」：
     *  - `@native:libfoo.so` → nativeLibraryDir/libfoo.so（可执行的 GCC 链接器）
     *  - 其他 → 相对链接所在目录的路径（sysroot 的 include/lib64/libstdc++ 等）
     */
    private fun applySymlinks() {
        val f = File(root, "symlinks.json")
        if (!f.isFile) return
        val map = runCatching { JSONObject(f.readText()) }.getOrNull() ?: return
        val native = nativeLibDir
        var created = 0
        var failed = 0
        val keys = map.keys()
        while (keys.hasNext()) {
            val link = keys.next()
            var target = map.optString(link)
            if (target.startsWith("@native:")) {
                target = File(native ?: continue, target.removePrefix("@native:")).absolutePath
            }
            val dst = File(root, link)
            if (lexists(dst)) continue
            dst.parentFile?.mkdirs()
            val ok = runCatching { Os.symlink(target, dst.absolutePath) }.isSuccess
            if (ok) {
                created++
            } else {
                failed++
                Log.w("ToolchainService", "symlink $link -> $target failed")
                // 回退：仅相对目标可以拷贝物化（绝对路径的 jniLibs 目标不可拷贝到 filesDir 执行）
                if (!target.startsWith("/")) {
                    val src = File(dst.parentFile, target)
                    if (src.isFile) runCatching { src.copyTo(dst, overwrite = true) }
                }
            }
        }
        Log.i("ToolchainService", "symlinks created=$created failed=$failed")
    }

    /** 从 assets/toolchain-<abi>.zip 解压（单个 zip 避免 AGP 对深层目录的资产合并丢文件问题） */
    private fun unzipAssets(onProgress: (Int) -> Unit = {}) {
        var done = 0
        val buf = ByteArray(65536)
        runCatching {
            ctx.assets.open(assetZip).use { ins ->
                java.util.zip.ZipInputStream(ins).use { zin ->
                    var e = zin.nextEntry
                    while (e != null) {
                        val name = e.name
                        if (name.startsWith("toolchain/")) {
                            val rel = name.removePrefix("toolchain/")
                            val dest = File(root, rel)
                            if (e.isDirectory) {
                                dest.mkdirs()
                            } else {
                                dest.parentFile?.mkdirs()
                                java.io.FileOutputStream(dest).use { outs ->
                                    var n: Int
                                    while (zin.read(buf).also { n = it } > 0) {
                                        outs.write(buf, 0, n)
                                    }
                                    outs.flush()
                                }
                                done++
                            }
                        }
                        zin.closeEntry()
                        if (done % 25 == 0) onProgress(done)
                        e = zin.nextEntry
                    }
                }
            }
        }
    }

    /** 按名字取可执行文件：jniLibs 里的优先（SELinux 可执行），其次 usr/bin */
    fun binary(name: String): File? {
        val dir = nativeLibDir
        if (dir != null) {
            val soName = nativeExeNames[name]
            if (soName != null) {
                val f = File(dir, soName)
                if (f.isFile) return f
            }
        }
        val a = File(usr, "bin/$name")
        if (a.exists()) return a
        return null
    }

    fun clangdPath(): String? = binary("clangd")?.absolutePath

    fun clangdReady(): Boolean = clangdPath() != null

    /** GCC 驱动（<triple>-gcc / <triple>-g++，包内同一个工具链的两个入口） */
    fun compiler(isC: Boolean): File? {
        val name = if (isC) "${abi.triple}-gcc" else "${abi.triple}-g++"
        val f = File(usr, "bin/$name")
        return if (f.isFile) f else null
    }

    fun compilerReady(): Boolean =
        compiler(true) != null && compiler(false) != null &&
            File(usr, "libexec/gcc/${abi.triple}/16/cc1plus").isFile

    /** clang 内建头文件所在目录（<usr>/lib/clang/<ver>），clangd 必须显式指定 */
    fun clangResourceDir(): File? =
        File(usr, "lib/clang").listFiles()
            ?.filter { it.isDirectory && File(it, "include").isDirectory }
            ?.maxByOrNull { it.name }

    /**
     * clangd 兜底 / compile_commands.json 用的参数（clang 语法）。
     * clangd 不认 GCC 的 -B / -wrapper，所以这里只给头文件路径、目标与 sysroot。
     *
     * 头文件与真实编译保持一致（libstdc++），这样 <bits/stdc++.h>、<ext/...>
     * 等 GCC 专有头在编辑器里也能补全/跳转；资源目录里只放 clang 的内建头
     * （stddef.h 等）。不要再传 -stdlib=libc++：那会让 clangd 只认 c++/v1，
     * 与 g++ 的实际编译结果不一致。
     */
    fun clangFlags(): List<String> {
        val flags = mutableListOf<String>()
        fun pushIsystem(dir: File) {
            if (dir.isDirectory) {
                flags += "-isystem"
                flags += dir.absolutePath
            }
        }
        val inc = File(usr, "include")
        pushIsystem(File(inc, "c++/16"))
        pushIsystem(File(inc, "c++/16/${abi.triple}"))
        pushIsystem(File(inc, "c++/16/backward"))
        val resDir = clangResourceDir()
        if (resDir != null) pushIsystem(File(resDir, "include"))
        // bionic：asm/ 头文件按架构分开安装
        pushIsystem(File(inc, abi.triple))
        pushIsystem(inc)
        if (resDir != null) flags += "-resource-dir=" + resDir.absolutePath
        flags += "-target"
        flags += abi.clangTarget + ANDROID_API_LEVEL
        flags += "-D__ANDROID_API__=$ANDROID_API_LEVEL"
        flags += "--sysroot=" + File(usr, abi.sysDir).absolutePath
        return flags
    }

    /**
     * 交给真实 GCC 驱动的参数：程序搜索路径、sysroot、API 宏，
     * 以及让 GCC 的所有子进程（cc1/cc1plus/as/collect2）都经 linker64 加载。
     */
    fun gccFlags(): List<String> {
        val flags = mutableListOf<String>()
        val inc = File(usr, "include")
        flags += "-B" + File(usr, "bin").absolutePath + "/"
        flags += "-B" + File(usr, "libexec/gcc/${abi.triple}/16").absolutePath + "/"
        flags += "-B" + File(usr, "lib/gcc/${abi.triple}/16").absolutePath + "/"
        flags += "--sysroot=" + File(usr, abi.sysDir).absolutePath
        // GCC 16 的 Android spec 禁止用 -D__ANDROID_API__ 指定平台版本，
        // 必须用 -mandroid-version-min（内部会定义 __ANDROID_API__ /
        // __ANDROID_MIN_SDK_VERSION__），否则报
        // "error setting the platform version ... use '-mandroid-version-min=<value>'"
        flags += "-mandroid-version-min=$ANDROID_API_LEVEL"
        // 头文件搜索路径显式给出，避免依赖 GCC 从 argv[0] 推导安装前缀
        // （驱动是被 linker64 加载的，argv[0] 未必是包内路径）
        fun pushIsystem(dir: File) {
            flags += "-isystem"
            flags += dir.absolutePath
        }
        pushIsystem(File(inc, "c++/16"))
        pushIsystem(File(inc, "c++/16/${abi.triple}"))
        pushIsystem(File(inc, "c++/16/backward"))
        pushIsystem(File(usr, "lib/gcc/${abi.triple}/16/include"))
        // bionic：asm/ 头文件按架构分目录安装
        pushIsystem(File(inc, abi.triple))
        pushIsystem(inc)
        flags += "-wrapper"
        flags += linkerPath()
        return flags
    }

    /** 运行环境：让可执行文件找到动态库，并提供可写的 HOME / 临时目录 */
    fun runEnv(): Map<String, String> {
        val lib = File(usr, "lib").absolutePath
        val bin = File(usr, "bin").absolutePath
        val tmp = File(ctx.cacheDir, "tmp").apply { mkdirs() }
        val nativeLib = nativeLibDir?.absolutePath.orEmpty()
        val path = listOf(nativeLib, bin, System.getenv("PATH").orEmpty())
            .filter { it.isNotEmpty() }
            .joinToString(":")
        return mapOf(
            "LD_LIBRARY_PATH" to listOf(lib, nativeLib).filter { it.isNotEmpty() }.joinToString(":"),
            "PATH" to path,
            "HOME" to ctx.filesDir.absolutePath,
            "TMPDIR" to tmp.absolutePath,
        )
    }

    private fun makeExecutable() {
        File(usr, "bin").listFiles()?.forEach { it.setExecutable(true, false) }
        File(usr, "libexec/gcc/${abi.triple}/16").listFiles()?.forEach { it.setExecutable(true, false) }
        File(usr, "lib").listFiles()?.forEach { if (it.name.endsWith(".so")) it.setExecutable(true, false) }
    }
}
