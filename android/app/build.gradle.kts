plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cppeditor.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cppeditor.app"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk {
            val abiProp2 = (findProperty("abi") as? String)?.trim()
            when (abiProp2) {
                "arm64-v8a" -> abiFilters += listOf("arm64-v8a")
                "armeabi-v7a" -> abiFilters += listOf("armeabi-v7a")
                else -> abiFilters += listOf("arm64-v8a", "armeabi-v7a")
            }
        }
    }

    // 共享前端：web/ 目录直接作为 assets 打进 APK，
    // WebViewAssetLoader 以 https://appassets.androidplatform.net/assets/ 提供。
    // 注意：Windows 专属工具链（resources/clangd、resources/mingw）是 git 忽略的，
    // 不得放进 web/ 下，否则会被打进 APK。
    sourceSets["main"].assets.srcDir("../../web")

    // 双 ABI 工具链默认全打。可用 -Pabi=arm64-v8a 或 -Pabi=armeabi-v7a 只打单包瘦身。
    val abiProp = (findProperty("abi") as? String)?.trim()
    when (abiProp) {
        null -> {
            sourceSets["main"].assets.srcDir("src/main/toolchain/arm64-v8a")
            sourceSets["main"].assets.srcDir("src/main/toolchain/armeabi-v7a")
        }
        "arm64-v8a" -> sourceSets["main"].assets.srcDir("src/main/toolchain/arm64-v8a")
        "armeabi-v7a" -> sourceSets["main"].assets.srcDir("src/main/toolchain/armeabi-v7a")
        else -> throw GradleException("未知 abi 属性：$abiProp（可选 arm64-v8a / armeabi-v7a）")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
}
