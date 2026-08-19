package com.cppeditor.app

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.result.ActivityResultLauncher
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * 文件服务：项目文件存放于应用内部目录 filesDir/projects（真实文件路径，
 * clangd / 编译器可直接访问）。「打开文件夹」通过 SAF 选择目录并导入到内部存储。
 */
class FilesService(
    private val ctx: Context,
    private val toolchain: ToolchainService,
    private val settings: SettingsService,
) {
    private val projectsRoot: File get() = File(ctx.filesDir, "projects")
    private var currentProject: File? = null

    private var clipboardPaths: MutableList<File> = mutableListOf()
    private var clipboardCut = false

    private var pendingPicker: PendingPick? = null
    private var launcher: ActivityResultLauncher<Uri?>? = null
    private var pendingSaveAs: PendingPick? = null
    private var saveAsContent: String? = null
    private var saveAsLauncher: ActivityResultLauncher<String>? = null

    private val imageExts = setOf("png", "jpg", "jpeg", "gif", "ico", "bmp", "webp", "svg")
    private val sourceExts = setOf("c", "cpp")

    /** 上次扫描的文件路径集合，用于计算 diff */
    private var lastTreePaths: Set<String> = emptySet()

    private class PendingPick(val callbackId: Int, val resolve: (Int, String) -> Unit)

    init {
        // 恢复上次打开的项目；不主动创建 default 项目（无项目时前端显示「打开文件夹」）
        val saved = settings.projectPath()
        if (saved != null) {
            val f = File(saved)
            if (f.isDirectory) currentProject = f
        }
    }

    val projectDir: File? get() = currentProject
    val projectsDir: File get() = projectsRoot

    fun registerPickerLauncher(l: ActivityResultLauncher<Uri?>) {
        launcher = l
    }

    fun registerSaveAsLauncher(l: ActivityResultLauncher<String>) {
        saveAsLauncher = l
    }

    fun requestOpenProjectFolder(callbackId: Int, resolve: (Int, String) -> Unit) {
        pendingPicker = PendingPick(callbackId, resolve)
        launcher?.launch(null)
    }

    fun requestChooseDirectory(callbackId: Int, resolve: (Int, String) -> Unit) {
        pendingPicker = PendingPick(callbackId, resolve)
        launcher?.launch(null)
    }

    fun requestSaveAs(content: String, suggestedName: String, callbackId: Int, resolve: (Int, String) -> Unit) {
        pendingSaveAs = PendingPick(callbackId, resolve)
        saveAsContent = content
        saveAsLauncher?.launch(suggestedName.ifEmpty { "未命名" })
    }

    fun onSaveAsPicked(uri: Uri?) {
        val pick = pendingSaveAs ?: return
        pendingSaveAs = null
        val content = saveAsContent
        saveAsContent = null
        if (uri == null) {
            pick.resolve(pick.callbackId, """{"cancelled":true}""")
            return
        }
        try {
            ctx.contentResolver.openOutputStream(uri)?.use { it.write((content ?: "").toByteArray(Charsets.UTF_8)) }
            val path = uri.lastPathSegment ?: uri.toString()
            pick.resolve(pick.callbackId, JSONObject()
                .put("ok", true)
                .put("path", path)
                .put("projectDir", currentProject?.absolutePath ?: "")
                .toString())
        } catch (e: Exception) {
            pick.resolve(pick.callbackId, errObject("保存失败: ${e.message}"))
        }
    }

    fun onFolderPicked(uri: Uri?) {
        val pick = pendingPicker ?: return
        pendingPicker = null
        if (uri == null) {
            pick.resolve(pick.callbackId, """{"cancelled":true}""")
            return
        }
        // 优先将 SAF tree URI 转换为真实文件系统路径（直接访问外部存储，无需复制）
        val fsPath = safTreeToPath(uri)
        if (fsPath != null) {
            val dir = File(fsPath)
            if (dir.isDirectory && dir.canRead()) {
                Thread {
                    try {
                        currentProject = dir
                        lastTreePaths = emptySet()
                        settings.saveProjectPath(dir.absolutePath)
                        writeCompileCommands()
                        val j = JSONObject()
                        j.put("projectDir", dir.absolutePath)
                        j.put("files", JSONArray(treeFiles(dir)))
                        pick.resolve(pick.callbackId, j.toString())
                        notifyProjectChanged()
                    } catch (e: Exception) {
                        pick.resolve(pick.callbackId, errObject("打开失败: " + (e.message ?: "")))
                    }
                }.apply { isDaemon = true }.start()
                return
            }
        }
        // 回退：复制到内部存储（SAF 虚拟文件系统，如云盘）
        val name = suggestedName(uri)
        var target = File(projectsRoot, name)
        var i = 1
        while (target.exists() && target.listFiles()?.isNotEmpty() == true) {
            target = File(projectsRoot, "$name-$i")
            i++
        }
        Thread {
            try {
                importTree(uri, target)
                if (target.listFiles().isNullOrEmpty()) {
                    pick.resolve(pick.callbackId, errObject("导入失败：目录为空或没有读取权限"))
                    return@Thread
                }
                currentProject = target
                lastTreePaths = emptySet()
                settings.saveProjectPath(target.absolutePath)
                writeCompileCommands()
                val j = JSONObject()
                j.put("projectDir", target.absolutePath)
                j.put("files", JSONArray(treeFiles(target)))
                pick.resolve(pick.callbackId, j.toString())
                notifyProjectChanged()
            } catch (e: Exception) {
                pick.resolve(pick.callbackId, errObject("导入失败: " + (e.message ?: "")))
            }
        }.apply { isDaemon = true }.start()
    }

    // --- 项目 / 文件读写 ------------------------------------------------------

    fun loadProject(): String {
        val cp = currentProject
        if (cp == null || !cp.isDirectory) {
            return JSONObject().put("projectDir", JSONObject.NULL).put("files", JSONArray()).toString()
        }
        val files = treeFiles(cp)
        lastTreePaths = files.map { it.getString("path") }.toSet()
        val j = JSONObject()
        j.put("projectDir", cp.absolutePath)
        j.put("files", JSONArray(files))
        return j.toString()
    }

    /** 从后台恢复时调用，重新扫描文件树并通知前端同步外部修改 */
    fun syncProject() {
        notifyProjectChanged()
    }

    fun getSaved(): String {
        val cp = currentProject
        if (cp == null) {
            return JSONObject()
                .put("ok", false)
                .put("missing", true)
                .put("path", JSONObject.NULL)
                .put("projectPath", JSONObject.NULL)
                .toString()
        }
        val f = File(cp, "main.cpp")
        if (!f.isFile) {
            return JSONObject()
                .put("ok", false)
                .put("missing", true)
                .put("path", f.absolutePath)
                .put("projectPath", cp.absolutePath)
                .toString()
        }
        return JSONObject()
            .put("ok", true)
            .put("path", f.absolutePath)
            .put("projectPath", cp.absolutePath)
            .put("content", f.readText())
            .toString()
    }

    fun saveAs(content: String, suggestedName: String?): String {
        val cp = currentProject
        if (cp == null) return errObject("尚未打开项目")
        val name = (suggestedName?.trim()?.ifEmpty { "未命名" }) ?: "未命名"
        val dest = uniquePath(cp, name)
        return try {
            dest.writeText(content)
            JSONObject()
                .put("ok", true)
                .put("path", dest.absolutePath)
                .put("projectDir", cp.absolutePath)
                .toString()
        } catch (e: Exception) {
            errObject("保存失败: ${e.message}")
        }
    }

    fun readFile(filePath: String): String {
        val f = File(filePath)
        if (!f.isFile) return errObject("文件不存在: $filePath")
        return try {
            val bytes = f.readBytes()
            val ext = f.extension.lowercase()
            val image = imageExts.contains(ext)
            var binary = image
            if (!binary) {
                for (b in bytes) if (b == 0.toByte()) { binary = true; break }
            }
            JSONObject()
                .put("ok", true)
                .put("path", f.absolutePath)
                .put("ext", ext)
                .put("mime", mime(ext))
                .put("binary", binary)
                .put("size", bytes.size)
                .put("content", if (binary) Base64.encodeToString(bytes, Base64.NO_WRAP) else String(bytes, Charsets.UTF_8))
                .toString()
        } catch (e: Exception) {
            errObject(e.message ?: "读取失败")
        }
    }

    fun saveFile(filePath: String, content: String): String {
        val f = File(filePath)
        return try {
            f.parentFile?.mkdirs()
            f.writeText(content)
            JSONObject().put("ok", true).put("path", f.absolutePath).toString()
        } catch (e: Exception) {
            errObject("保存失败: ${e.message}")
        }
    }

    // --- 文件树操作 -----------------------------------------------------------

    fun treeOp(method: String, args: JSONArray): String {
        return when (method) {
            "treeCopy" -> treeCopy(args)
            "treeCut" -> treeCut(args)
            "treePaste" -> treePaste(args.optString(0))
            "treeRename" -> treeRename(args.optString(0), args.optString(1))
            "treeDelete" -> treeDelete(args)
            "treeReveal" -> """{"ok":true}"""
            "treeCreateFile" -> treeCreateFile(args.optString(0), args.optString(1), args.optString(2))
            "treeCreateDir" -> treeCreateDir(args.optString(0), args.optString(1))
            else -> errObject("未知操作: $method")
        }
    }

    private fun treeCopy(args: JSONArray): String {
        val list = sanitizePaths(args)
        if (list.isEmpty()) return errObject("没有可复制的文件")
        clipboardPaths = list.toMutableList()
        clipboardCut = false
        return """{"ok":true,"count":${list.size}}"""
    }

    private fun treeCut(args: JSONArray): String {
        val list = sanitizePaths(args)
        if (list.isEmpty()) return errObject("没有可剪切的文件")
        clipboardPaths = list.toMutableList()
        clipboardCut = true
        return """{"ok":true,"count":${list.size}}"""
    }

    private fun treePaste(destDir: String): String {
        val dest = File(destDir)
        if (!dest.isDirectory) return errObject("目标文件夹无效")
        val results = JSONArray()
        var failed = 0
        for (src in clipboardPaths) {
            if (!src.exists()) {
                results.put(JSONObject().put("src", src.absolutePath).put("ok", false).put("message", "源文件不存在"))
                failed++
                continue
            }
            val dst = uniquePath(dest, src.name)
            if (dst.absolutePath.startsWith(src.absolutePath + File.separator)) {
                results.put(JSONObject().put("src", src.absolutePath).put("ok", false).put("message", "不能将文件夹复制到其自身内部"))
                failed++
                continue
            }
            try {
                if (clipboardCut) {
                    src.renameTo(dst)
                    if (!dst.exists()) copyRecursive(src, dst).also { src.deleteRecursively() }
                } else {
                    copyRecursive(src, dst)
                }
                results.put(JSONObject()
                    .put("src", src.absolutePath)
                    .put("dest", dst.absolutePath)
                    .put("isDirectory", src.isDirectory)
                    .put("ok", true))
            } catch (e: Exception) {
                results.put(JSONObject().put("src", src.absolutePath).put("ok", false).put("message", e.message))
                failed++
            }
        }
        if (clipboardCut) {
            clipboardCut = false
            if (failed == 0) clipboardPaths = mutableListOf()
        }
        notifyProjectChanged()
        return JSONObject().put("ok", failed == 0).put("results", results).toString()
    }

    private fun treeRename(oldPath: String, newName: String): String {
        if (newName.isBlank()) return errObject("文件名不能为空")
        if (Regex("[\\\\/:*?\"<>|]").containsMatchIn(newName)) return errObject("文件名包含非法字符")
        if (newName == "." || newName == "..") return errObject("文件名不合法")
        val old = File(oldPath)
        if (!old.exists()) return errObject("源文件不存在")
        val dest = File(old.parentFile, newName)
        if (dest.exists()) return errObject("已存在同名文件或文件夹")
        return try {
            old.renameTo(dest)
            notifyProjectChanged()
            JSONObject()
                .put("ok", true)
                .put("oldPath", old.absolutePath)
                .put("newPath", dest.absolutePath)
                .put("isDirectory", old.isDirectory)
                .toString()
        } catch (e: Exception) {
            errObject(e.message ?: "重命名失败")
        }
    }

    private fun treeDelete(args: JSONArray): String {
        val list = sanitizePaths(args)
        val results = JSONArray()
        var failed = 0
        for (f in list) {
            if (!f.exists()) {
                results.put(JSONObject().put("path", f.absolutePath).put("ok", false).put("message", "文件不存在"))
                failed++
                continue
            }
            try {
                f.deleteRecursively()
                results.put(JSONObject().put("path", f.absolutePath).put("ok", true))
            } catch (e: Exception) {
                results.put(JSONObject().put("path", f.absolutePath).put("ok", false).put("message", e.message))
                failed++
            }
        }
        notifyProjectChanged()
        return JSONObject().put("ok", failed == 0).put("results", results).toString()
    }

    private fun treeCreateFile(dir: String, name: String, content: String): String {
        val d = File(dir)
        if (!d.isDirectory) return errObject("目标文件夹无效")
        val err = checkName(name)
        if (err != null) return errObject(err)
        val dest = File(d, name)
        if (dest.exists()) return errObject("已存在同名文件")
        return try {
            dest.writeText(content)
            notifyProjectChanged()
            JSONObject().put("ok", true).put("path", dest.absolutePath).toString()
        } catch (e: Exception) {
            errObject(e.message ?: "创建失败")
        }
    }

    private fun treeCreateDir(dir: String, name: String): String {
        val d = File(dir)
        if (!d.isDirectory) return errObject("目标文件夹无效")
        val err = checkName(name)
        if (err != null) return errObject(err)
        val dest = File(d, name)
        if (dest.exists()) return errObject("已存在同名文件夹")
        return try {
            dest.mkdirs()
            notifyProjectChanged()
            JSONObject().put("ok", true).put("path", dest.absolutePath).toString()
        } catch (e: Exception) {
            errObject(e.message ?: "创建失败")
        }
    }

    // --- 内部工具 -------------------------------------------------------------

    private fun checkName(name: String): String? {
        if (name.isBlank()) return "文件名不能为空"
        if (Regex("[\\\\/:*?\"<>|]").containsMatchIn(name)) return "文件名包含非法字符"
        if (name == "." || name == "..") return "文件名不合法"
        return null
    }

    private fun sanitizePaths(args: JSONArray): List<File> {
        val out = mutableListOf<File>()
        for (i in 0 until args.length()) {
            val p = args.optString(i)
            if (p.isBlank()) continue
            val f = File(p)
            if (!f.isAbsolute) continue
            // 允许当前项目目录下的路径（包括外部存储的项目路径）
            val cp = currentProject
            if (cp != null && f.absolutePath.startsWith(cp.absolutePath)) {
                if (out.any { it.absolutePath == f.absolutePath }) continue
                out.add(f)
            }
        }
        return out
    }

    private fun uniquePath(dir: File, name: String): File {
        val ext = name.substringAfterLast('.', "")
        val base = if (ext.isEmpty()) name else name.removeSuffix(".$ext")
        var cand = File(dir, name)
        var i = 1
        while (cand.exists()) {
            cand = File(dir, if (ext.isEmpty()) "$base ($i)" else "$base ($i).$ext")
            i++
        }
        return cand
    }

    private fun copyRecursive(src: File, dest: File) {
        if (src.isDirectory) {
            dest.mkdirs()
            src.listFiles()?.forEach { copyRecursive(it, File(dest, it.name)) }
        } else {
            src.copyTo(dest, overwrite = false)
        }
    }

    private fun treeFiles(dir: File): MutableList<JSONObject> {
        val out = mutableListOf<JSONObject>()
        val entries = dir.listFiles() ?: return out
        for (e in entries.sortedBy { it.name }) {
            if (e.isFile && e.extension.equals("exe", true)) continue
            if (e.name == "compile_commands.json" || e.name == ".cache") continue
            if (e.name.startsWith(".")) continue
            out.add(JSONObject().put("path", e.absolutePath).put("isDirectory", e.isDirectory))
            if (e.isDirectory) out.addAll(treeFiles(e))
        }
        return out
    }

    private fun writeCompileCommands() {
        val cp = currentProject ?: return
        writeCompileCommands(cp, toolchain, settings)
    }

    private fun notifyProjectChanged() {
        val cp = currentProject ?: return
        val files = treeFiles(cp)
        val currentPaths = files.map { it.getString("path") }.toSet()

        val added = files.filter { it.getString("path") !in lastTreePaths }
        val removed = lastTreePaths.filter { it !in currentPaths }

        lastTreePaths = currentPaths

        val changed = JSONObject()
        changed.put("projectDir", cp.absolutePath)
        changed.put("added", JSONArray(added))
        changed.put("removed", JSONArray(removed))
        changed.put("modified", JSONArray())
        EventBus.post("lsp:project-changed", changed.toString())
    }

    // --- SAF 导入 -------------------------------------------------------------

    private fun suggestedName(uri: Uri): String {
        val id = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return "project"
        return id.substringAfterLast(':').substringAfterLast('/').ifEmpty { "project" }
    }

    /**
     * 将 SAF tree document URI 转为真实文件系统路径。
     * 仅对本地存储（内部/外部/emulated）有效；云盘等虚拟提供者返回 null。
     * 树 document ID 格式：`<volume>:<path>`，例如 `primary:MyProject` → `/storage/emulated/0/MyProject`。
     */
    private fun safTreeToPath(uri: Uri): String? {
        val docId = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return null
        if (!docId.contains(':')) return null
        val volume = docId.substringBefore(':')
        val subPath = docId.substringAfter(':')
        val basePath = when (volume) {
            "primary" -> "/storage/emulated/0"
            "external" -> "/storage/emulated/0"
            else -> {
                // 其它卷（SD 卡、USB）：/storage/<volumeId>
                if (volume.matches(Regex("^[0-9a-fA-F-]+$"))) "/storage/$volume" else return null
            }
        }
        return if (subPath.isEmpty()) basePath else "$basePath/$subPath"
    }

    private fun importTree(uri: Uri, dest: File) {
        dest.mkdirs()
        val children = ctx.contentResolver.query(uri, null, null, null, null)
        children?.use { c ->
            val idCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
            while (c.moveToNext()) {
                val id = c.getString(idCol) ?: continue
                val name = c.getString(nameCol) ?: continue
                val mime = c.getString(mimeCol) ?: ""
                val childDoc = DocumentsContract.buildDocumentUriUsingTree(uri, id)
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    val dir = File(dest, name)
                    dir.mkdirs()
                    val childDirUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri, id)
                    importTree(childDirUri, dir)
                } else {
                    runCatching {
                        ctx.contentResolver.openInputStream(childDoc)?.use { ins ->
                            FileOutputStream(File(dest, name)).use { outs -> ins.copyTo(outs) }
                        }
                    }
                }
            }
        }
    }

    private fun defaultMainCpp(): String {
        return "#include <iostream>\n\nint main() {\n    std::cout << \"Hello, CppEditor!\" << std::endl;\n    return 0;\n}\n"
    }

    private fun mime(ext: String): String {
        return when (ext) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "svg" -> "image/svg+xml"
            "html" -> "text/html"
            "css" -> "text/css"
            "json" -> "application/json"
            "md" -> "text/markdown"
            else -> "text/plain"
        }
    }
}
