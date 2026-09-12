package com.cppeditor.app

import android.content.res.Configuration
import android.os.Build
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding

/**
 * 横屏时隐藏系统导航栏与状态栏（沉浸式），竖屏恢复显示系统导航栏。
 * 需要各 Activity 在 onResume / onConfigurationChanged 中调用。
 */
fun ComponentActivity.applyImmersiveOnLandscape() {
    val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    // 全屏父主题自带 FLAG_FULLSCREEN，不清除会导致竖屏状态下状态栏无法恢复显示
    window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
    val decor = window.decorView
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val controller = WindowCompat.getInsetsController(window, decor)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (landscape) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    } else {
        @Suppress("DEPRECATION")
        val base = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        @Suppress("DEPRECATION")
        val immersive = base or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        @Suppress("DEPRECATION")
        decor.systemUiVisibility = if (landscape) immersive else base
    }
}

/**
 * Android 15+（targetSdk 35+）强制 edge-to-edge，且无法通过 setDecorFitsSystemWindows 退出，
 * WebView 会被拉到状态栏 / 导航栏 / 挖孔区域下面，内容被系统控件遮挡。
 * 这里把 系统栏 + 挖孔 + 软键盘 的 insets 作为内容容器的 padding，让 WebView 绘制在安全区域内；
 * 横屏沉浸式（系统栏隐藏）时相应 insets 为 0，自动恢复全屏。
 * 在 onCreate 中 setContentView 之后调用一次即可；预留区配色由 applyThemeBackground 负责。
 */
fun ComponentActivity.applySystemBarInsets() {
    val content = window.decorView.findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
        val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
        val cutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout())
        val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
        view.updatePadding(
            left = maxOf(systemBars.left, cutout.left),
            top = maxOf(systemBars.top, cutout.top),
            right = maxOf(systemBars.right, cutout.right),
            bottom = maxOf(systemBars.bottom, cutout.bottom, ime.bottom),
        )
        WindowInsetsCompat.CONSUMED
    }
}

/**
 * 关闭系统在透明状态栏 / 导航栏上叠加的默认对比度 scrim（3 按钮导航时为浅色遮罩，
 * 会在深色模式下让预留区发白），保证预留区只显示应用自身上的颜色。
 */
fun ComponentActivity.disableSystemBarContrastScrim() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        window.isStatusBarContrastEnforced = false
        window.isNavigationBarContrastEnforced = false
    }
}

/**
 * 根据配色主题调整状态栏 / 导航栏图标的明暗，避免亮色主题下深色图标叠加在浅色底上不可见。
 */
fun ComponentActivity.applyBarAppearance(lightTheme: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = lightTheme
    controller.isAppearanceLightNavigationBars = lightTheme
}

/** 与前端页面背景一致的主题色，用于系统栏预留区。 */
fun themeBackgroundColor(theme: String): Int =
    if (theme == "light") 0xFFFAFAFA.toInt() else 0xFF1E1E1E.toInt()

/**
 * 应用主题对应的原生配色：窗口背景、系统栏预留区容器背景、状态栏 / 导航栏图标明暗。
 * 需在 setContentView 之后调用（会查找 android.R.id.content），供 onCreate 与主题切换时复用。
 */
fun ComponentActivity.applyThemeBackground(theme: String) {
    val bgColor = themeBackgroundColor(theme)
    window.decorView.setBackgroundColor(bgColor)
    window.decorView.findViewById<View>(android.R.id.content)?.setBackgroundColor(bgColor)
    applyBarAppearance(theme == "light")
}
