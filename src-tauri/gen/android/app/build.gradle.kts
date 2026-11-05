import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Properties
import javax.inject.Inject
import org.gradle.process.ExecOperations

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

// The certificate verifier is a Rust crate with a Kotlin half, published as
// a Maven archive; the two must be the same version, so the Kotlin one is
// the version cargo resolves for Android.
abstract class RustlsVersion : ValueSource<String, RustlsVersion.Params> {
    interface Params : ValueSourceParameters {
        val manifest: RegularFileProperty
    }

    @get:Inject
    abstract val execOperations: ExecOperations

    override fun obtain(): String {
        val output = ByteArrayOutputStream()
        execOperations.exec {
            commandLine(
                "cargo", "tree", "--target", "aarch64-linux-android", "-e", "normal",
                "--prefix", "none", "--format", "{p}",
                "--manifest-path", parameters.manifest.get().asFile.path,
            )
            standardOutput = output
        }
        return Regex("""rustls-platform-verifier-android v(\S+)""")
            .find(output.toString(Charsets.UTF_8))?.groupValues?.get(1)
            ?: error("rustls-platform-verifier-android not found in cargo tree")
    }
}

val rustlsPlatformVerifierVersion = providers.of(RustlsVersion::class.java) {
    parameters.manifest.set(layout.projectDirectory.file("../../../Cargo.toml"))
}

configurations.configureEach {
    resolutionStrategy.eachDependency {
        if (requested.group == "org.rustls" && requested.name == "rustls-platform-verifier") {
            useVersion(rustlsPlatformVerifierVersion.get())
            because("the Kotlin verifier must match the rustls-platform-verifier-android crate")
        }
    }
}

repositories {
    maven {
        url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/")
    }
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.obsidianirc.dev"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.obsidianirc.dev"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            val keystorePropsFile = rootProject.file("keystore.properties")
            if (keystorePropsFile.exists()) {
                val keystoreProps = Properties().apply {
                    keystorePropsFile.inputStream().use { load(it) }
                }
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            } else {
                val debugKeystore = File(System.getProperty("user.home"), ".android/debug.keystore")
                if (debugKeystore.exists()) {
                    storeFile = debugKeystore
                    storePassword = "android"
                    keyAlias = "androiddebugkey"
                    keyPassword = "android"
                }
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            // Only attach the release signingConfig when a real keystore was
            // resolved above. On CI runners that ship without ~/.android/
            // debug.keystore and don't write keystore.properties (the
            // workflow signs the AAB/APK afterwards via apksigner), the
            // signingConfig is half-initialised (storeFile == null) and
            // packageUniversalRelease fails with `SigningConfig "release"
            // is missing required property "storeFile"`. Leaving it unset
            // produces an unsigned artifact, which the workflow then signs.
            val releaseSign = signingConfigs.getByName("release")
            if (releaseSign.storeFile != null) {
                signingConfig = releaseSign
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("org.rustls:rustls-platform-verifier")
    implementation("androidx.webkit:webkit:1.6.1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.8.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")