package com.cppeditor.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * 管理打包在 assets/toolchain-<abi>.zip 中的工具链（clang / clang++ / clangd / 头文件 / 动态库）。
 * 按设备 ABI 选择 32 位（armeabi-v7a）或 64 位（arm64-v8a）包，
 * 首次启动解压到应用内部目录，按 linkmap.json 物化符号链接并设置可执行位。
 */
class ToolchainService(private val ctx: Context) {

    enum class Abi(val zipAsset: String, val target: String, val isystemDir: String, val gccTriple: String) {
        ARM64("toolchain-arm64-v8a.zip", "aarch64-linux-android", "aarch64-linux-android", "aarch64-linux-android"),
        ARM32("toolchain-armeabi-v7a.zip", "armv7a-linux-androideabi", "arm-linux-androideabi", "arm-linux-androideabi");

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

    /** nativeLibraryDir 由 PackageManager 在安装时解压 jniLibs 得到，
     *  可在 MIUI 等严格 SELinux 设备上绕过 execute_no_trans 限制 */
    val nativeLibDir: File? by lazy {
        val dir = File(ctx.applicationInfo.nativeLibraryDir)
        if (dir.isDirectory && dir.listFiles()?.isNotEmpty() == true) dir else null
    }

    private val nativeExeNames = mapOf(
        "clangd" to "libclangd.so",
        "clang-21" to "libclang21.so",
        "gcc" to "libgcc.so",
        "g++" to "libgpp.so",
        "gcc-16" to "libgcc16.so",
        "g++-16" to "libgpp16.so",
        "lld" to "liblld.so",
        "ld.lld" to "libldlld.so",
        "ld" to "liblld.so",
        "ld64.lld" to "liblld.so",
        "lld-link" to "liblld.so",
        "wasm-ld" to "liblld.so",
        "arm-linux-androideabi-ld" to "liblld.so",
        "armv7a-linux-androideabi-ld" to "liblld.so",
        "aarch64-linux-android-ld" to "liblld.so",
    )

    private val assetZip: String get() = abi.zipAsset

    /** 工具链是否已解压就绪（g++/clangd 等可执行文件已物化 + ELF 完整） */
    fun ready(): Boolean = File(usr, "lib").isDirectory && binary("clang-21") != null && verifyExtracted()

    /**
     * 首次启动在后台线程解压工具链，避免主线程长时间阻塞导致启动卡死 / ANR
     * （32 位设备解压 80MB+ 需要数分钟）。期间广播 toolchain:progress（{"done":n}），
     * 完成广播 toolchain:ready（"true"/"false"）。
     */
    fun ensureExtracted(onDone: (Boolean) -> Unit = {}) {
        if (ready()) {
            linkNativeSubprograms()
            onDone(true)
            return
        }
        Thread {
            val ok = runCatching {
                unzipAssets { done -> if (done % 25 == 0) postToolchain("toolchain:progress", """{"done":$done}""") }
                applyLinkmap()
                makeExecutable()
                linkNativeSubprograms()
                fixGccSpecs()
                writeGccCompatHeader()
                fixBuiltinLibs()
                verifyExtracted()
            }.getOrDefault(false)
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
            val ok = runCatching {
                unzipAssets { done -> if (done % 25 == 0) postToolchain("toolchain:progress", """{"done":$done}""") }
                applyLinkmap()
                makeExecutable()
                linkNativeSubprograms()
                fixGccSpecs()
                writeGccCompatHeader()
                fixBuiltinLibs()
                verifyExtracted()
            }.getOrDefault(false)
            EventBus.post("toolchain:ready", ok.toString())
            onDone(ok)
        }.apply { isDaemon = true }.start()
    }

    private fun verifyExtracted(): Boolean {
        val critical = listOf("usr/lib/libLLVM.so", "usr/lib/libclang-cpp.so")
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
            if (header[0] != 0x7f.toByte() || header[1] != 'E'.code.toByte() || header[2] != 'L'.code.toByte() || header[3] != 'F'.code.toByte()) {
                Log.e("ToolchainService", "invalid ELF in $rel (${f.length()} bytes)")
                return false
            }
            Log.i("ToolchainService", "verified $rel (${f.length()} bytes)")
        }
        return true
    }

    private fun postToolchain(channel: String, payload: String) {
        Handler(Looper.getMainLooper()).post { EventBus.post(channel, payload) }
    }

    /** 符号链接在打包时以 linkmap.json（link 路径 -> 实体文件路径）表示，这里用拷贝物化 */
    private fun applyLinkmap() {
        val lm = File(root, "linkmap.json")
        if (!lm.isFile) return
        val map = runCatching { JSONObject(lm.readText()) }.getOrNull() ?: return
        val keys = map.keys()
        while (keys.hasNext()) {
            val link = keys.next()
            val target = map.optString(link)
            val src = File(root, target)
            val dst = File(root, link)
            if (!src.isFile || dst.exists()) {
                Log.i("ToolchainService", "applyLinkmap skip: $link (srcIsFile=${src.isFile} dstExists=${dst.exists()})")
                continue
            }
            runCatching {
                dst.parentFile?.mkdirs()
                src.copyTo(dst)
                Log.i("ToolchainService", "applyLinkmap copied: $link <- $target")
            }.onFailure { e -> Log.e("ToolchainService", "applyLinkmap failed: $link <- $target: ${e.message}") }
        }
    }

    /**
     * 工具链 zip 中 clang builtins 库用 Android NDK 命名约定（lib/linux/libclang_rt.builtins-<arch>-android.a），
     * 但 clang 驱动按标准 LLVM 约定查找 lib/<triple>/libclang_rt.builtins.a。
     * 这里创建缺失的目录+拷贝文件，让链接器能正确找到 builtins。
     */
    private fun fixBuiltinLibs() {
        val clangLib = File(usr, "lib/clang/21/lib") ?: return
        if (!clangLib.isDirectory) return
        val linuxDir = File(clangLib, "linux")
        if (!linuxDir.isDirectory) return
        // clang 内部将 target triple 规范化（如 aarch64-linux-android → aarch64-unknown-linux-android）
        val candidates = listOf(
            abi.target,
            abi.target.replaceFirst("-linux-", "-unknown-linux-")
        )
        linuxDir.listFiles()?.filter { it.name.startsWith("libclang_rt.builtins") && it.name.endsWith(".a") }?.forEach { src ->
            for (triple in candidates) {
                val tripleDir = File(clangLib, triple)
                if (tripleDir.isDirectory) continue
                tripleDir.mkdirs()
                val dst = File(tripleDir, "libclang_rt.builtins.a")
                if (!dst.exists()) {
                    runCatching { src.copyTo(dst) }
                }
            }
        }
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
                                    if (name.endsWith(".so")) outs.fd.sync()
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

    fun binary(name: String): File? {
        if (File(usr, "lib").isDirectory) {
            val dir = nativeLibDir
            if (dir != null) {
                val soName = nativeExeNames[name]
                if (soName != null) {
                    val f = File(dir, soName)
                    if (f.isFile) return f
                }
            }
        }
        val a = File(usr, "bin/$name")
        if (a.isFile) return a
        val b = File(root, "bin/$name")
        if (b.isFile) return b
        return null
    }

    fun clangdPath(): String? = binary("clangd")?.absolutePath

    fun clangdReady(): Boolean = clangdPath() != null

    companion object GccV {
        const val GCC_VERSION = "16.1.0"
    }

    /** gcc lib 目录（specs / cc1plus / libgcc.a / crt 对象 所在） */
    fun gccLibDir(): File? {
        val dir = File(usr, "lib/gcc/${abi.gccTriple}/$GCC_VERSION")
        return if (dir.isDirectory) dir else null
    }

    /** gcc 的子程序（cc1/cc1plus/collect2）目录 */
    fun gccExecDir(): File? {
        val dir = File(usr, "libexec/gcc/${abi.gccTriple}/$GCC_VERSION")
        return if (dir.isDirectory) dir else null
    }

    /**
     * g++-16 编译标志（与 clangFlags() 不同：无 --target / -resource-dir，
     * cc1/cc1plus/as 已复制到 nativeLibDir（apk_data_file，SELinux 可 exec），
     * 用 -B 指向 nativeLibDir 让 gcc driver 找到它们；-D__ANDROID_API__ 指定 API）。
     */
    fun compileFlags(): List<String> {
        val flags = mutableListOf<String>()
        fun pushIsystem(dir: File) {
            if (dir.isDirectory) {
                flags += "-isystem"
                flags += dir.absolutePath
            }
        }
        val inc = File(usr, "include")
        pushIsystem(File(inc, "c++/v1"))
        pushIsystem(File(inc, abi.isystemDir))
        pushIsystem(inc)
        flags += "-D__ANDROID_API__=24"
        // bionic 头是 clang 专用，GCC 需 force-include 兼容头置空 clang 专属宏
        val compat = File(inc, "gcc_compat.h")
        if (compat.isFile) {
            flags += "-include"
            flags += compat.absolutePath
        }
        // 子程序（cc1/cc1plus/as）在 nativeLibDir 才可执行（untrusted_app 域对 apk_data_file 有 execute_no_trans，
        // 对 app_data_file 没有），-B 让 driver 从 nativeLibDir 找到它们
        val native = nativeLibDir
        if (native != null && File(native, "cc1plus").isFile) {
            flags += "-B${native.absolutePath}"
        }
        return flags
    }

    fun clangReady(): Boolean = binary("clang") != null && binary("clang++") != null

    /** gcc/g++（linkmap 物化后为真 GCC 的 gcc-16/g++-16）是否可用 */
    fun compilerReady(): Boolean = binary("gcc") != null && binary("g++") != null

    /** bionic/NDK 头是 clang 专用（_Nonnull/__INTRODUCED_IN 等），GCC 编译需兼容头置空这些宏 */
    private val gccCompatHeader =
        "/* Generated by CppEditor: neutralize clang-only constructs for GCC */\n" +
        "#pragma once\n" +
        "#if defined(__BIONIC__) || defined(__ANDROID__)\n" +
        "#include <android/versioning.h>\n" +
        "#endif\n" +
        "#undef __BIONIC_AVAILABILITY\n#define __BIONIC_AVAILABILITY(...)\n" +
        "#undef __BIONIC_AVAILABILITY_GUARD\n#define __BIONIC_AVAILABILITY_GUARD(api_level) 1\n" +
        "#undef __INTRODUCED_IN\n#define __INTRODUCED_IN(api_level)\n" +
        "#undef __DEPRECATED_IN\n#define __DEPRECATED_IN(api_level, msg)\n" +
        "#undef __REMOVED_IN\n#define __REMOVED_IN(api_level, msg)\n" +
        "#undef __INTRODUCED_IN_32\n#define __INTRODUCED_IN_32(api_level)\n" +
        "#undef __INTRODUCED_IN_64\n#define __INTRODUCED_IN_64(api_level)\n" +
        "#undef __DEPRECATED_IN_32\n#define __DEPRECATED_IN_32(api_level, msg)\n" +
        "#undef __DEPRECATED_IN_64\n#define __DEPRECATED_IN_64(api_level, msg)\n" +
        "#undef __REMOVED_IN_32\n#define __REMOVED_IN_32(api_level, msg)\n" +
        "#undef __REMOVED_IN_64\n#define __REMOVED_IN_64(api_level, msg)\n" +
        "#undef __clang_error_if\n#define __clang_error_if(cond, msg)\n" +
        "#undef __clang_warning_if\n#define __clang_warning_if(cond, msg)\n" +
        "#undef __pass_object_size_n\n#define __pass_object_size_n(n)\n" +
        "#undef __pass_object_size\n#define __pass_object_size __pass_object_size_n(0)\n" +
        "#undef __pass_object_size0\n#define __pass_object_size0\n" +
        "#undef __enable_if\n#define __enable_if(cond, msg)\n" +
        "#undef __prefer_this_overload\n#define __prefer_this_overload\n" +
        "#ifndef __clang__\n#define _Nonnull\n#define _Nullable\n#define _Null_unspecified\n#endif\n"

    private fun writeGccCompatHeader() {
        if (!usr.isDirectory) return
        val f = File(usr, "include/gcc_compat.h")
        runCatching {
            f.writeText(gccCompatHeader)
            Log.i("ToolchainService", "wrote gcc_compat.h (${f.length()} bytes)")
        }.onFailure { Log.e("ToolchainService", "write gcc_compat.h failed: ${it.message}") }
    }

    /** 将 specs 文件中的 __TC__ 占位符替换为实际工具链 usr 路径（运行时修正） */
    private fun fixGccSpecs() {
        val gccDir = gccLibDir() ?: return
        val specsFile = File(gccDir, "specs")
        if (!specsFile.isFile) return
        val content = specsFile.readText()
        if (!content.contains("__TC__")) return
        specsFile.writeText(content.replace("__TC__", usr.absolutePath))
        Log.i("ToolchainService", "fixed gcc specs: __TC__ -> ${usr.absolutePath}")
    }

    /** clangd 兜底编译参数：sysroot + 头文件搜索路径 + 目标平台 */
    fun clangFlags(): List<String> {
        val flags = mutableListOf<String>()
        fun pushIsystem(dir: File) {
            if (dir.isDirectory) {
                flags += "-isystem"
                flags += dir.absolutePath
            }
        }
        val inc = File(usr, "include")
        pushIsystem(File(inc, "c++/v1"))
        File(usr, "lib/clang").listFiles()?.sortedBy { it.name }?.forEach { d ->
            pushIsystem(File(d, "include"))
        }
        pushIsystem(File(inc, abi.isystemDir))
        pushIsystem(inc)
        flags += "-target"
        flags += abi.target
        flags += "-D__ANDROID_API__=24"
        flags += "--sysroot=" + usr.absolutePath
        flags += "-resource-dir=" + File(usr, "lib/clang/21").absolutePath
        return flags
    }

    /** 运行环境：让可执行文件找到动态库，并提供可写的 HOME / 临时目录 */
    fun runEnv(): Map<String, String> {
        val lib = File(usr, "lib").absolutePath
        val bin = File(usr, "bin").absolutePath
        val tmp = File(ctx.cacheDir, "tmp").apply { mkdirs() }
        val nativeLib = nativeLibDir?.absolutePath.orEmpty()
        val path = buildString {
            if (nativeLib.isNotEmpty()) append(nativeLib)
            if (nativeLib.isNotEmpty() && bin.isNotEmpty()) append(":")
            if (bin.isNotEmpty()) append(bin)
            val sysPath = System.getenv("PATH").orEmpty()
            if (sysPath.isNotEmpty()) append(":").append(sysPath)
        }
        val gccDir = gccLibDir()
        val ldPath = buildString {
            append(lib)
            if (gccDir != null) append(":").append(gccDir.absolutePath)
            if (nativeLib.isNotEmpty()) append(":").append(nativeLib)
        }
        val env = mutableMapOf<String, String>(
            "LD_LIBRARY_PATH" to ldPath,
            "PATH" to path,
            "HOME" to ctx.filesDir.absolutePath,
            "TMPDIR" to tmp.absolutePath,
        )
        if (gccDir != null) {
            // GCC_EXEC_PREFIX={usr}/lib/gcc/ 让 gcc driver 找 specs 时命中
            // {GCC_EXEC_PREFIX}{machine}/{version}/specs == <usr>/lib/gcc/<triple>/<ver>/specs。
            // （cc1/cc1plus/collect2 由 applyLinkmap 物化到 usr/bin，靠 PATH 里的 usr/bin 由 execvp 命中）
            env["GCC_EXEC_PREFIX"] = File(usr, "lib/gcc").absolutePath + "/"
        }
        return env
    }

    private fun makeExecutable() {
        val bin = File(usr, "bin")
        if (bin.isDirectory) bin.listFiles()?.forEach { it.setExecutable(true, false) }
        val lib = File(usr, "lib")
        if (lib.isDirectory) lib.listFiles()?.forEach { if (it.name.endsWith(".so")) it.setExecutable(true, false) }
        // gcc 子程序（cc1/cc1plus/collect2）在 libexec 下，copyTo 物化后无执行位；
        // 若 driver 经 -B/GCC_EXEC_PREFIX 直接命中会 execvp Permission denied，故补齐执行位
        val libexec = File(usr, "libexec/gcc")
        if (libexec.isDirectory) {
            libexec.walkTopDown().filter { it.isFile }.forEach { it.setExecutable(true, false) }
        }
    }

    /**
     * nativeLibDir 仅提取 .so；gcc 需要 exec cc1/cc1plus/as（按裸名）。
     * 在 usr/bin 建符号链接指向 nativeLibDir 里的 libcc1.so/libcc1plus.so/libas.so，
     * 目标为 apk_data_file（untrusted_app 有 execute_no_trans，可 exec）。
     * 同时删除 libexec 下的同名实体：GCC 在 exec_prefixes（含 libexec/gcc/...，
     * app_data_file）里找到 cc1/cc1plus 会优先于 PATH 使用 → execv Permission denied；
     * 删掉后 driver 只能 fallback 到 PATH → usr/bin symlink → native（可 exec）。
     */
    private fun linkNativeSubprograms() {
        val native = nativeLibDir ?: return
        val bin = File(usr, "bin")
        val tripleDir = gccExecDir()
        val pairs = mapOf(
            "cc1" to "libcc1.so",
            "cc1plus" to "libcc1plus.so",
            "as" to "libas.so",
        )
        for ((name, lib) in pairs) {
            // 删除 libexec 实体，迫使 driver fallback 到 PATH（usr/bin symlink）
            if (tripleDir != null) {
                for (prefix in listOf(tripleDir.absolutePath, gccLibDir()?.absolutePath.orEmpty())) {
                    if (prefix.isNotEmpty()) {
                        val dead = File(prefix, name)
                        if (dead.isFile) runCatching { dead.delete() }
                    }
                }
                runCatching { File(File(usr, "libexec/gcc"), "${abi.gccTriple}/${GCC_VERSION}/$name").delete() }
            }
            val target = File(native, lib)
            if (!target.isFile) continue
            if (!bin.isDirectory) continue
            val link = File(bin, name)
            runCatching {
                if (link.exists()) link.delete()
                android.system.Os.symlink(target.absolutePath, link.absolutePath)
                Log.i("ToolchainService", "symlink $name -> ${target.absolutePath}")
            }.onFailure { Log.e("ToolchainService", "symlink $name failed: ${it.message}") }
        }
    }
}
