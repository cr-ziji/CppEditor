package com.cppeditor.app

import android.content.res.Configuration
import android.os.Build
import android.view.View
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 横屏时隐藏系统导航栏与状态栏（沉浸式），竖屏恢复显示系统导航栏。
 * 需要各 Activity 在 onResume / onConfigurationChanged 中调用。
 */
fun ComponentActivity.applyImmersiveOnLandscape() {
    val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
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
