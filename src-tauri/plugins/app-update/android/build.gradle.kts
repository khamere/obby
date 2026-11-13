plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "world.obby.appupdate"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("proguard-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // The app compiles with Kotlin 2.1, which reads metadata up to 2.2.
    implementation("org.jetbrains.kotlin:kotlin-stdlib") { version { strictly("2.2.10") } }
    implementation(project(":tauri-android"))
    // The plugin lifecycle hooks take an AppCompatActivity; this is the version tauri-android uses.
    implementation("androidx.appcompat:appcompat:1.6.0")
    testImplementation("junit:junit:4.13.2")
}
