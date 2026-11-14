package world.obby.appupdate

import android.app.Activity
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject

@InvokeArg
class StartDownloadArgs {
  lateinit var url: String
  lateinit var sha256: String
  var size: Long = 0
  lateinit var version: String
  var allowedHosts: Array<String> = arrayOf()
}

private const val MAX_REDIRECTS = 5
private const val PROGRESS_INTERVAL_MS = 250L
private val REDIRECTS = setOf(301, 302, 303, 307, 308)
private val SHA256_HEX = Regex("^[0-9a-fA-F]{64}$")
private const val EXTRA_TOKEN = "world.obby.appupdate.TOKEN"

private class UpdateFailure(val code: String) : Exception(code)

private class Status(
  val phase: String,
  val received: Long = 0,
  val total: Long = 0,
  val error: String? = null,
) {
  fun toJS(): JSObject {
    val result = JSObject()
    result.put("phase", phase)
    result.put("received", received)
    result.put("total", total)
    result.put("error", error ?: JSONObject.NULL)
    return result
  }
}

private class Job(
  val url: String,
  val sha256: String,
  val size: Long,
  val version: String,
  val allowedHosts: List<String>,
) {
  // The version names the file, so we keep it to characters a file name can hold.
  val stem: String = version.replace(Regex("[^A-Za-z0-9._-]"), "_").trimStart('.').ifEmpty { "update" }

  @Volatile var isCancelled = false
  @Volatile var isFinished = false
  @Volatile var isVerified = false
  @Volatile var sessionId = -1
  @Volatile var isWritingSession = false
  @Volatile var connection: HttpURLConnection? = null

  // Android's prompt for the committed session, read and written on the main thread only.
  var confirmation: Intent? = null

  fun cancel() {
    isCancelled = true
    connection?.disconnect()
  }
}

@TauriPlugin
class AppUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    // One thread for every plugin instance, so a recreated activity's download
    // never writes the same file as the one before it.
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { task ->
      Thread(task, "obby-app-update").apply { isDaemon = true }
    }
  }

  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())
  private var current: Job? = null
  private var status = Status("idle")

  private val updateDir: File get() = File(activity.cacheDir, "update")

  private val statusAction = "${activity.packageName}.APP_UPDATE_STATUS"

  // Before Android 13 a receiver registered at runtime takes broadcasts from
  // any app, so we only believe a status that carries this token back.
  private val token = UUID.randomUUID().toString()

  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      onSessionStatus(intent)
    }
  }

  // A finished APK is either installed or abandoned by the next start, while a
  // part file is a download the user can still resume.
  override fun load(webView: WebView) {
    super.load(webView)
    worker.execute {
      updateDir.listFiles()?.filter { it.name.endsWith(".apk") }?.forEach { it.delete() }
    }
    val filter = IntentFilter(statusAction)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.applicationContext.registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      activity.applicationContext.registerReceiver(statusReceiver, filter)
    }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    try {
      activity.applicationContext.unregisterReceiver(statusReceiver)
    } catch (e: IllegalArgumentException) {
      // load() never ran, so there is nothing to unregister
    }
  }

  // Android shows its install prompt only to an app in front, so a verified
  // update waits here for the user to come back.
  override fun onResume(activity: AppCompatActivity) {
    val (job, phase) = synchronized(lock) { current to status.phase }
    if (job == null || !job.isVerified) return
    if (phase == "waiting-foreground" || (phase == "needs-permission" && canInstallPackages())) {
      offerInstall(job, isInFront = true)
    }
  }

  @Command
  fun startDownload(invoke: Invoke) {
    val args = invoke.parseArgs(StartDownloadArgs::class.java)
    if (args.size <= 0 || args.url.isBlank()) {
      invoke.reject("no-apk")
      return
    }
    if (!SHA256_HEX.matches(args.sha256)) {
      invoke.reject("checksum")
      return
    }
    val job = synchronized(lock) {
      val running = current
      if (running != null && running.version == args.version && !running.isFinished && !running.isCancelled) {
        invoke.resolve(status.toJS())
        return
      }
      running?.cancel()
      Job(args.url, args.sha256, args.size, args.version, args.allowedHosts.toList()).also {
        current = it
        status = Status("downloading", 0, it.size)
      }
    }
    invoke.resolve(status.toJS())
    worker.execute { run(job) }
  }

  @Command
  fun cancelDownload(invoke: Invoke) {
    val job = synchronized(lock) {
      val running = current
      current = null
      status = Status("idle")
      running
    }
    job?.cancel()
    // A committed session would otherwise keep its prompt and install the update the user just cancelled.
    if (job != null) main.post { abandonSession(job) }
    // The worker runs one task at a time, so this waits for the cancelled download to let go of its file.
    worker.execute {
      updateDir.listFiles()?.filter { it.name.endsWith(".apk.part") }?.forEach { it.delete() }
    }
    emit(Status("idle"))
    invoke.resolve()
  }

  @Command
  fun downloadStatus(invoke: Invoke) {
    invoke.resolve(synchronized(lock) { status }.toJS())
  }

  @Command
  fun openInstallSettings(invoke: Invoke) {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
    } else {
      Intent(Settings.ACTION_SECURITY_SETTINGS)
    }
    main.post {
      try {
        activity.startActivity(intent)
        invoke.resolve()
      } catch (e: ActivityNotFoundException) {
        invoke.reject("refused")
      }
    }
  }

  @Command
  fun retryInstall(invoke: Invoke) {
    main.post {
      val (job, phase) = synchronized(lock) { current to status.phase }
      if (job == null || !job.isVerified || !apkOf(job).isFile) {
        invoke.reject("storage")
        return@post
      }
      if (phase == "installing") showPromptAgain(job) else offerInstall(job, isInFront())
      invoke.resolve(synchronized(lock) { status }.toJS())
    }
  }

  private fun run(job: Job) {
    try {
      val part = prepare(job)
      if (part.length() != job.size) download(job, part)
      if (job.isCancelled) return
      publish(job, Status("verifying", job.size, job.size))
      if (part.length() != job.size || !sha256Matches(sha256Of(part), job.sha256)) {
        part.delete()
        throw UpdateFailure("checksum")
      }
      if (!part.renameTo(apkOf(job))) throw UpdateFailure("storage")
      job.isVerified = true
      main.post { offerInstall(job, isInFront()) }
    } catch (e: Exception) {
      if (job.isCancelled) return
      val code = when (e) {
        is UpdateFailure -> e.code
        is IOException -> "network"
        else -> "storage"
      }
      publish(job, Status("error", 0, job.size, code))
    } finally {
      job.isFinished = true
      job.connection = null
    }
  }

  /** Clears every other update from the cache and returns the part file for this one. */
  private fun prepare(job: Job): File {
    val dir = updateDir
    if (!dir.isDirectory && !dir.mkdirs()) throw UpdateFailure("storage")
    val part = File(dir, "${job.stem}.apk.part")
    // A finished file for this version goes back through the checksum rather than being trusted or fetched again.
    val apk = apkOf(job)
    if (apk.exists() && !apk.renameTo(part)) apk.delete()
    dir.listFiles()?.filter { it.name != part.name }?.forEach { it.deleteRecursively() }
    if (part.length() > job.size) part.delete()
    return part
  }

  private fun download(job: Job, part: File) {
    // A server that will not continue where the part file ends gets one more
    // request for the whole file.
    for (attempt in 0..1) {
      val offset = part.length()
      val conn = open(job, offset)
      try {
        val code = conn.responseCode
        val resume = resumeDecision(offset, code, contentRangeStart(conn.getHeaderField("Content-Range")))
        if (code != 200 && resume !is Resume.Append) {
          if (offset > 0 && (code == 206 || code == 416)) {
            part.delete()
            continue
          }
          throw UpdateFailure("network")
        }
        receive(job, conn, part, resume)
      } finally {
        conn.disconnect()
      }
      if (job.isCancelled) return
      if (part.length() < job.size) throw UpdateFailure("network")
      return
    }
    throw UpdateFailure("network")
  }

  /** Opens the download, following redirects ourselves so every hop has to be an allowed HTTPS host. */
  private fun open(job: Job, offset: Long): HttpURLConnection {
    var url = URL(job.url)
    repeat(MAX_REDIRECTS + 1) {
      if (job.isCancelled) throw UpdateFailure("network")
      if (url.protocol != "https" || !isAllowedHost(url.host, job.allowedHosts)) throw UpdateFailure("network")
      val conn = url.openConnection() as HttpURLConnection
      job.connection = conn
      conn.instanceFollowRedirects = false
      conn.connectTimeout = 15_000
      conn.readTimeout = 30_000
      conn.setRequestProperty("User-Agent", "Obby")
      // Android would otherwise ask for gzip and hide the byte counts a range depends on.
      conn.setRequestProperty("Accept-Encoding", "identity")
      if (offset > 0) conn.setRequestProperty("Range", "bytes=$offset-")
      if (conn.responseCode !in REDIRECTS) return conn
      val location = conn.getHeaderField("Location")
      conn.disconnect()
      url = URL(url, location ?: throw UpdateFailure("network"))
    }
    throw UpdateFailure("network")
  }

  private fun receive(job: Job, conn: HttpURLConnection, part: File, resume: Resume) {
    var received = if (resume is Resume.Append) resume.offset else 0L
    val out = try {
      FileOutputStream(part, resume is Resume.Append)
    } catch (e: IOException) {
      throw UpdateFailure("storage")
    }
    try {
      val input = conn.inputStream
      val buffer = ByteArray(64 * 1024)
      var lastProgress = 0L
      publish(job, Status("downloading", received, job.size))
      while (!job.isCancelled) {
        val count = input.read(buffer)
        if (count < 0) break
        received += count
        if (received > job.size) {
          part.delete()
          throw UpdateFailure("checksum")
        }
        try {
          out.write(buffer, 0, count)
        } catch (e: IOException) {
          throw UpdateFailure("storage")
        }
        val now = SystemClock.elapsedRealtime()
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          lastProgress = now
          publish(job, Status("downloading", received, job.size))
        }
      }
    } finally {
      try {
        out.close()
      } catch (e: IOException) {
        if (!job.isCancelled) throw UpdateFailure("storage")
      }
    }
  }

  private fun sha256Of(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    try {
      FileInputStream(file).use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          digest.update(buffer, 0, count)
        }
      }
    } catch (e: IOException) {
      throw UpdateFailure("storage")
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun apkOf(job: Job) = File(updateDir, "${job.stem}.apk")

  private fun canInstallPackages(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

  private fun isInFront(): Boolean =
    (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) ?: false

  /** Moves a verified [job] on to the install, or to whatever the install is still waiting for. Runs on the main thread. */
  private fun offerInstall(job: Job, isInFront: Boolean) {
    if (job.isCancelled) return
    val apk = apkOf(job)
    val next = when {
      !apk.isFile -> Status("error", 0, job.size, "storage")
      !canInstallPackages() -> Status("needs-permission", job.size, job.size)
      !isInFront -> Status("waiting-foreground", job.size, job.size)
      else -> Status("installing", job.size, job.size)
    }
    publish(job, next)
    if (next.phase != "installing") return
    val held = job.confirmation
    if (held != null) {
      openConfirmation(job, held)
    } else {
      job.isWritingSession = true
      worker.execute { install(job, apk) }
    }
  }

  /**
   * Brings Android's prompt back after the user left it unanswered. The prompt lives in the installer's own task, so
   * returning to the app does not show it and only the user can ask for it. Runs on the main thread.
   */
  private fun showPromptAgain(job: Job) {
    when (promptRetry(job.confirmation != null, job.isWritingSession)) {
      PromptRetry.Reopen -> job.confirmation?.let { openConfirmation(job, it) }
      PromptRetry.Wait -> Unit
      PromptRetry.Restart -> {
        abandonSession(job)
        offerInstall(job, isInFront())
      }
    }
  }

  /** Gives up the installer session of [job], so Android can no longer install from it. Runs on the main thread. */
  private fun abandonSession(job: Job) {
    val sessionId = job.sessionId
    job.sessionId = -1
    job.confirmation = null
    if (sessionId == -1) return
    try {
      activity.packageManager.packageInstaller.abandonSession(sessionId)
    } catch (e: Exception) {
      // the session is already gone
    }
  }

  /** Copies [apk] into an installer session and commits it; the result arrives in [onSessionStatus]. */
  private fun install(job: Job, apk: File) {
    val installer = activity.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      // Android then refuses an APK that is some other app rather than our own update.
      setAppPackageName(activity.packageName)
      setSize(apk.length())
    }
    var sessionId = -1
    try {
      sessionId = installer.createSession(params)
      job.sessionId = sessionId
      installer.openSession(sessionId).use { session ->
        FileInputStream(apk).use { input ->
          session.openWrite("base.apk", 0, apk.length()).use { output ->
            input.copyTo(output, 64 * 1024)
            session.fsync(output)
          }
        }
        if (job.isCancelled) {
          session.abandon()
          return
        }
        session.commit(statusSender(sessionId))
      }
    } catch (e: Exception) {
      if (sessionId != -1) {
        try {
          installer.abandonSession(sessionId)
        } catch (ignored: Exception) {
          // the session is already gone
        }
      }
      publish(job, Status("error", 0, job.size, if (e is IOException) "storage" else "refused"))
    } finally {
      job.isWritingSession = false
    }
  }

  private fun statusSender(sessionId: Int): IntentSender {
    val intent = Intent(statusAction).setPackage(activity.packageName).putExtra(EXTRA_TOKEN, token)
    // The installer adds the status and its confirmation intent to ours, so the intent has to stay mutable.
    val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    return PendingIntent.getBroadcast(activity, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutable)
      .intentSender
  }

  private fun onSessionStatus(intent: Intent) {
    if (intent.getStringExtra(EXTRA_TOKEN) != token) return
    val job = synchronized(lock) { current } ?: return
    // An abandoned session still reports its end, and that end says nothing about the job.
    val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
    if (sessionId == -1 || sessionId != job.sessionId) return
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val outcome = installOutcome(status)
    if (outcome != InstallOutcome.NeedsUser) job.confirmation = null
    when (outcome) {
      InstallOutcome.NeedsUser -> {
        val confirm = confirmationOf(intent)
        job.confirmation = confirm
        when {
          confirm == null -> publish(job, Status("error", 0, job.size, "refused"))
          isInFront() -> openConfirmation(job, confirm)
          // Android drops an activity started from the background without telling us.
          else -> publish(job, Status("waiting-foreground", job.size, job.size))
        }
      }
      InstallOutcome.Installed -> {
        apkOf(job).delete()
        publish(job, Status("idle"))
      }
      // The APK stays in the cache, so trying again needs no second download.
      is InstallOutcome.Failed -> publish(job, Status("error", 0, job.size, outcome.code))
    }
  }

  private fun openConfirmation(job: Job, confirm: Intent) {
    try {
      activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      publish(job, Status("installing", job.size, job.size))
    } catch (e: RuntimeException) {
      // A prompt that will not open is of no use a second time, so trying again starts a new session.
      abandonSession(job)
      publish(job, Status("error", 0, job.size, "refused"))
    }
  }

  private fun confirmationOf(intent: Intent): Intent? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_INTENT)
    }

  /** Records [next] as the status, unless [job] has been cancelled or replaced since. */
  private fun publish(job: Job, next: Status) {
    synchronized(lock) {
      if (job !== current || job.isCancelled) return
      status = next
    }
    emit(next)
  }

  // The plugin's listener list is not synchronised, so we send every event from one thread.
  private fun emit(next: Status) {
    main.post { trigger("update", next.toJS()) }
  }
}
