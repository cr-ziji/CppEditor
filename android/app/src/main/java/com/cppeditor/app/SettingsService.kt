package com.cppeditor.app

import android.content.Context
import org.json.JSONObject

/** 编译设置快照 */
data class CompileSettings(
    val languageStandardCpp: String,
    val languageStandardC: String,
    val warningLevel: Int,
    val compilerCommand: String,
    val linkerCommand: String,
)

/** 设置持久化：SharedPreferences 存 JSON，结构与 Electron 版 settings.json 一致 */
class SettingsService(private val ctx: Context) {

    private val prefs get() = ctx.getSharedPreferences("cppeditor", Context.MODE_PRIVATE)
    private val groups = listOf("compile", "editor", "templates", "shortcuts")
    private val legacyKeys = listOf("autoClosingBrackets", "autoClosingQuotes", "bracketPairColorization", "matchBrackets")

    /** 上次打开的项目目录（与 settings 分开存，避免被前端设置写入覆盖） */
    fun projectPath(): String? = prefs.getString("projectPath", null)

    fun saveProjectPath(path: String) {
        prefs.edit().putString("projectPath", path).apply()
    }

    fun load(): String {
        val raw = prefs.getString("settings", null) ?: return defaultSettings()
        return try {
            JSONObject(raw).toString()
        } catch (_: Exception) {
            defaultSettings()
        }
    }

    fun save(patch: JSONObject?): String {
        val cur = try {
            JSONObject(prefs.getString("settings", "{}") ?: "{}")
        } catch (_: Exception) {
            JSONObject()
        }
        if (patch != null) {
            for (g in groups) {
                val v = patch.optJSONObject(g) ?: continue
                val old = cur.optJSONObject(g) ?: JSONObject()
                val merged = JSONObject()
                val keys = (old.keys().asSequence().toList() + v.keys().asSequence().toList()).distinct()
                for (k in keys) merged.put(k, if (v.has(k)) v.get(k) else old.opt(k))
                cur.put(g, merged)
            }
        }
        val ed = cur.optJSONObject("editor")
        if (ed != null) for (k in legacyKeys) ed.remove(k)
        prefs.edit().putString("settings", cur.toString()).apply()
        EventBus.post("settings:changed", cur.toString())
        return cur.toString()
    }

    fun compileSettings(): CompileSettings {
        val j = try {
            JSONObject(load())
        } catch (_: Exception) {
            JSONObject()
        }
        val c = j.optJSONObject("compile") ?: JSONObject()
        return CompileSettings(
            languageStandardCpp = c.optString("languageStandardCpp", "c++17"),
            languageStandardC = c.optString("languageStandardC", "c11"),
            warningLevel = c.optInt("warningLevel", 2),
            compilerCommand = c.optString("compilerCommand", ""),
            linkerCommand = c.optString("linkerCommand", ""),
        )
    }

    private fun defaultSettings(): String {
        val editor = JSONObject()
            .put("theme", "dark")
            .put("fontSize", 14)
            .put("fileTreeFontSize", 14)
            .put("fileTreeWidth", 300)
        val compile = JSONObject()
            .put("languageStandardCpp", "c++17")
            .put("languageStandardC", "c11")
            .put("warningLevel", 2)
        return JSONObject().put("editor", editor).put("compile", compile).toString()
    }
}
