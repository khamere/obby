# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Called only from Rust over JNI (src-tauri/src/socket.rs); R8 cannot see the caller.
-keep class com.obsidianirc.dev.MainActivity {
    public static void showIrcNotification(int, java.lang.String, java.lang.String);
    public static void nativeInitAndroid(com.obsidianirc.dev.MainActivity);
    public static void nativeSetAppFocused(boolean);
    public native <methods>;
}
-keep class com.obsidianirc.dev.MainActivity$Companion {
    public void showIrcNotification(int, java.lang.String, java.lang.String);
    public void nativeInitAndroid(com.obsidianirc.dev.MainActivity);
    public void nativeSetAppFocused(boolean);
    public native <methods>;
}
