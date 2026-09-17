# gcc-16 工具链集成 Kotlin 代码改造方案

## 总览

编译步骤切换到真实 g++-16（gcc-16），链接步骤保持 ld.lld 不变。
clangd 和 compile_commands.json 继续使用 clang flags（保持 clangd 兼容）。

---

## 1. ToolchainService.kt 改造

### 1.1 nativeExeNames 添加 gcc-16

```kotlin
private val nativeExeNames = mapOf(
    "clangd" to "libclangd.so",
    "clang-21" to "libclang21.so",
    "gcc" to "libgcc.so",      // 保留旧映射（向后兼容）
    "g++" to "libgpp.so",
    "gcc-16" to "libgcc16.so",  // 新增：gcc-16 驱动
    "g++-16" to "libgpp16.so",  // 新增：g++-16 驱动
    "lld" to "liblld.so",
    "ld.lld" to "libldlld.so",
    // ...其余不变
)
```

> 打包脚本需把 `usr/bin/gcc-16` 重命名为 `libgcc16.so`，`usr/bin/g++-16` 重命名为 `libgpp16.so`，
> 放到 APK 的 jniLibs 目录中，让 PackageManager 解压后放在 nativeLibDir 里（绕过 SELinux）。

### 1.2 新增 gccLibDir()

```kotlin
/** gcc lib 目录（specs / cc1plus / libgcc.a / crt 对象 所在） */
fun gccLibDir(): File? {
    val triple = when (abi) {
        Abi.ARM64 -> "aarch64-linux-android"
        Abi.ARM32 -> "arm-linux-androideabi"
    }
    val dir = File(usr, "lib/gcc/$triple/16.1.0")
    return if (dir.isDirectory) dir else null
}
```

### 1.3 compilerReady() 改检查 gcc-16

```kotlin
fun compilerReady(): Boolean = binary("gcc-16") != null && binary("g++-16") != null
```

### 1.4 runEnv() 添加 GCC_EXEC_PREFIX + LD_LIBRARY_PATH

```kotlin
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
    val gccLib = gccLibDir()?.absolutePath.orEmpty()
    val ldPath = buildString {
        append(lib)
        if (gccLib.isNotEmpty()) append(":").append(gccLib)
        if (nativeLib.isNotEmpty()) append(":").append(nativeLib)
    }
    val env = mutableMapOf(
        "LD_LIBRARY_PATH" to ldPath,
        "PATH" to path,
        "HOME" to ctx.filesDir.absolutePath,
        "TMPDIR" to tmp.absolutePath,
    )
    if (gccLib.isNotEmpty()) {
        env["GCC_EXEC_PREFIX"] = gccLib
    }
    return env
}
```

### 1.5 compileFlags() — 给 g++-16 编译用的 flags

```kotlin
/** g++-16 编译标志（与 clangFlags() 不同：无 --target / -resource-dir，改用 -D__ANDROID_API__） */
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
    // 给 gcc 指定 cc1/cc1plus 路径（即使有 GCC_EXEC_PREFIX，-B 是双保险）
    val gccDir = gccLibDir()
    if (gccDir != null) {
        flags += "-B${gccDir.absolutePath}"
    }
    return flags
}
```

### 1.6 clangFlags() 改名 / 保留给 clangd 用

```kotlin
/** clangd 兜底编译参数：sysroot + 头文件搜索路径 + 目标平台 */
fun clangFlags(): List<String> { ... }  // 保持不变
```

### 1.7 fixGccSpecs() — 运行时替换 __TC__ 占位符

```kotlin
/** 将 specs 文件中的 __TC__ 占位符替换为实际工具链 usr 路径 */
private fun fixGccSpecs() {
    val gccDir = gccLibDir() ?: return
    val specsFile = File(gccDir, "specs")
    if (!specsFile.isFile) return
    val content = specsFile.readText()
    if (!content.contains("__TC__")) return
    specsFile.writeText(content.replace("__TC__", usr.absolutePath))
    Log.i("ToolchainService", "fixed gcc specs: __TC__ -> ${usr.absolutePath}")
}
```

### 1.8 ensureExtracted() 和 resetAndReExtract() 添加 fixGccSpecs()

```kotlin
// 在 applyLinkmap(); makeExecutable(); 后面加:
fixGccSpecs()
```

---

## 2. CompileService.kt 改造

### 2.1 doCompile() 编译步骤改用 g++-16 + compileFlags()

```kotlin
// 原:
val compiler = if (isC) toolchain.binary("gcc")?.absolutePath ?: "gcc"
               else toolchain.binary("g++")?.absolutePath ?: "g++"
val cArgs = mutableListOf<String>()
cArgs += toolchain.clangFlags()
// 改:
val compiler = if (isC) toolchain.binary("gcc-16")?.absolutePath ?: "gcc-16"
               else toolchain.binary("g++-16")?.absolutePath ?: "g++-16"
val cArgs = mutableListOf<String>()
cArgs += toolchain.compileFlags()
```

其余不变（compileArgs、objFile、link step 全部保持）。

### 2.2 链接步骤 — 添加 libgcc.a 查找路径

```kotlin
// 在现有 linkArgs 基础上，追加 gcc lib 路径:
toolchain.gccLibDir()?.let { linkArgs += "-L${it.absolutePath}" }
```

> 这样 ld.lld 就能找到 libgcc.a（从 g++-16 的包里来的）。
> 当前链接链里有 `-lgcc`，需要 libgcc.a 在 -L 搜索路径中。

---

## 3. CompileDb.kt — 不改

compile_commands.json 继续使用 `clangFlags()`，clangd 用 clang 语义理解代码。
gcc-16 只是编译执行器，不影响 clangd 索引。

---

## 4. ClangdService.kt — 不改

fallbackFlags() 继续用 clangFlags()，clangd 保持 clang 兼容。

---

## 5. 打包脚本必须配合的改动

工具链 zip 中需要额外添加：
- `usr/bin/gcc-16` → 在打包时重命名为 `usr/bin/libgcc16.so`（等效）
- `usr/bin/g++-16` → 在打包时重命名为 `usr/bin/libgpp16.so`（等效）
- 或者：在 `assemble-toolchain.ps1` 中完成重命名

specs 文件内容中 `/data/data/com.termux/files/usr` → `__TC__`（组装脚本已处理）。

---

## 6. 测试计划

1. 在 Windows 上运行 `assemble-toolchain.ps1` 得到两个 zip
2. 把 zip 放入 `android/app/src/main/assets/`
3. `./gradlew assembleDebug`
4. 安装到测试设备（联想 aarch64 root, 小米 armv7 未root, 联想 aarch64 Android 14 未root）
5. 新建 C++ 文件 → 编译 → 检查 .o 由 g++-16 生成（检查编译日志）
6. 链接 → 检查 ELF 由 ld.lld 链接
7. 运行 → 检查输出正确
8. clangd 诊断 → 检查补全/跳转仍正常
