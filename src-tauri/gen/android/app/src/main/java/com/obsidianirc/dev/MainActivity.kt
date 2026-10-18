package com.obsidianirc.dev

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.WebView
import androidx.annotation.Keep
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private lateinit var wv: WebView
  private var isKeyboardOpen = false

  companion object {
    @SuppressLint("StaticFieldLeak")
    @Volatile
    var appContext: Context? = null

    init {
      try {
        System.loadLibrary("app_lib")
      } catch (e: Throwable) {
        Log.e("Obby", "Failed to load app_lib in MainActivity: ${e.message}", e)
      }
    }

    @Keep
    @JvmStatic
    external fun nativeInitAndroid(activity: MainActivity)

    @Keep
    @JvmStatic
    external fun nativeSetAppFocused(focused: Boolean)

    // Only called from Rust over JNI, so R8 sees no callers and would strip it.
    @Keep
    @JvmStatic
    fun showIrcNotification(id: Int, title: String, body: String) {
      try {
        val ctx = appContext
        if (ctx == null) {
          Log.e("Obby", "Cannot show IRC notification: appContext is null")
          return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          if (
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) !=
              PackageManager.PERMISSION_GRANTED
          ) {
            Log.w("Obby", "Cannot show IRC notification: POST_NOTIFICATIONS permission not granted")
            return
          }
        }

        val channelId = "obby_messages"
        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          val channel = NotificationChannel(
            channelId,
            "IRC Mentions & Messages",
            NotificationManager.IMPORTANCE_HIGH,
          ).apply {
            description = "Notifications for IRC direct messages and mentions"
            enableVibration(true)
          }
          manager.createNotificationChannel(channel)
        }

        val openIntent = Intent(ctx, MainActivity::class.java).apply {
          action = Intent.ACTION_MAIN
          addCategory(Intent.CATEGORY_LAUNCHER)
          flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        } else {
          PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pendingIntent = PendingIntent.getActivity(ctx, id, openIntent, pendingFlags)

        val notification = NotificationCompat.Builder(ctx, channelId)
          .setContentTitle(title)
          .setContentText(body)
          .setStyle(NotificationCompat.BigTextStyle().bigText(body))
          .setSmallIcon(android.R.drawable.stat_notify_chat)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setDefaults(NotificationCompat.DEFAULT_ALL)
          .setAutoCancel(true)
          .setContentIntent(pendingIntent)
          .build()

        manager.notify(id, notification)
        Log.i("Obby", "Displayed IRC notification id=$id")
      } catch (e: Throwable) {
        Log.e("Obby", "Failed to show IRC notification: ${e.message}", e)
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appContext = applicationContext
    try {
      nativeInitAndroid(this)
    } catch (e: Throwable) {
      Log.e("Obby", "nativeInitAndroid failed in onCreate: ${e.message}", e)
    }
    requestNotificationPermissionIfNeeded()
    startKeepAliveService()
  }

  override fun onResume() {
    super.onResume()
    appContext = applicationContext
    try {
      nativeInitAndroid(this)
      nativeSetAppFocused(true)
    } catch (e: Throwable) {
      Log.e("Obby", "nativeSetAppFocused(true) failed: ${e.message}", e)
    }
    startKeepAliveService()
  }

  override fun onPause() {
    try {
      nativeSetAppFocused(false)
    } catch (e: Throwable) {
      Log.e("Obby", "nativeSetAppFocused(false) failed: ${e.message}", e)
    }
    super.onPause()
  }

  private fun requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED
      ) {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(Manifest.permission.POST_NOTIFICATIONS),
          1001,
        )
      }
    }
  }

  private fun startKeepAliveService() {
    try {
      val serviceIntent = Intent(this, IrcKeepAliveService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        startForegroundService(serviceIntent)
      } else {
        startService(serviceIntent)
      }
    } catch (_: Throwable) {
    }
  }
  
  override fun onWebViewCreate(webView: WebView) {
    wv = webView
    setupKeyboardDetection()
  }
  
  private fun setupKeyboardDetection() {
    val rootView = findViewById<View>(android.R.id.content)
    val globalLayoutListener = ViewTreeObserver.OnGlobalLayoutListener {
      val rect = Rect()
      rootView.getWindowVisibleDisplayFrame(rect)
      val screenHeight = rootView.rootView.height
      val keypadHeight = screenHeight - rect.bottom

      if (keypadHeight > screenHeight * 0.15) { // keyboard is opened
        if (!isKeyboardOpen) {
          isKeyboardOpen = true
          // Force immediate layout adjustment
          wv.evaluateJavascript("window.dispatchEvent(new Event('keyboardDidShow'));", null)
        }
      } else { // keyboard is closed
        if (isKeyboardOpen) {
          isKeyboardOpen = false
          wv.evaluateJavascript("window.dispatchEvent(new Event('keyboardDidHide'));", null)
        }
      }
    }
    
    rootView.viewTreeObserver.addOnGlobalLayoutListener(globalLayoutListener)
  }
  
  @SuppressLint("MissingSuperCall", "SetTextI18n")
  @Deprecated("")
  override fun onBackPressed() {
    wv.evaluateJavascript(/* script = */ """
      try {
        window.androidBackCallback()
      } catch (_) {
        true
      }
    """.trimIndent()) { result ->
      if (result == "true") {
        super.onBackPressed();
      }
    }
  }
}

class IrcKeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      MainActivity.appContext = applicationContext
      val channelId = "obby_keepalive"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
          channelId,
          "IRC Background Connection",
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "Keeps the IRC bouncer connection active in the background"
          setShowBadge(false)
          setSound(null, null)
        }
        manager.createNotificationChannel(channel)

        val msgChannel = NotificationChannel(
          "obby_messages",
          "IRC Mentions & Messages",
          NotificationManager.IMPORTANCE_HIGH,
        ).apply {
          description = "Notifications for IRC direct messages and mentions"
          enableVibration(true)
        }
        manager.createNotificationChannel(msgChannel)
      }

      val openIntent = Intent(this, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
        this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pendingIntent = PendingIntent.getActivity(this, 0, openIntent, pendingFlags)

      val notification = NotificationCompat.Builder(this, channelId)
        .setContentTitle("Obby")
        .setContentText("Connected to IRC")
        .setSmallIcon(R.mipmap.ic_launcher)
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setContentIntent(pendingIntent)
        .build()

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(1001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(1001, notification)
      }
    } catch (e: Throwable) {
      Log.e("Obby", "IrcKeepAliveService startForeground failed: ${e.message}", e)
    }
    return START_STICKY
  }
}