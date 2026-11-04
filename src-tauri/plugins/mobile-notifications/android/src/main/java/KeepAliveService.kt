package world.obby.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

// Android cuts a background app's sockets within minutes. A foreground
// service with its own notification keeps the process, and so the IRC
// connections, alive while the app is off the screen. The page starts and
// stops it as networks connect and disconnect.
class KeepAliveService : Service() {
  companion object {
    private const val NOTIFICATION_ID = 7001
    private const val CHANNEL_ID = "connection"
    private const val STATUS_KEY = "status"
    private const val NAME_KEY = "channelName"

    fun start(context: Context, status: String, channelName: String) {
      val intent = Intent(context, KeepAliveService::class.java)
        .putExtra(STATUS_KEY, status)
        .putExtra(NAME_KEY, channelName)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, KeepAliveService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val status = intent?.getStringExtra(STATUS_KEY) ?: "Obby"
    val channelName = intent?.getStringExtra(NAME_KEY) ?: "Connection"
    createChannel(channelName)
    val notification = build(status)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // Without the app process there is no connection to keep, so a service
    // the system restarts on its own would only show a stale notification.
    return START_NOT_STICKY
  }

  private fun createChannel(name: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW)
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  private fun build(status: String): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)
    val tap = open?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val icon = resources.getIdentifier("ic_notification", "drawable", packageName)
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(if (icon != 0) icon else applicationInfo.icon)
      .setContentTitle("Obby")
      .setContentText(status)
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(tap)
      .build()
  }
}
