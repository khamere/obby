package world.obby.appupdate

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
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
  @Volatile var connection: HttpURLConnection? = null

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

  // A finished APK is either installed or abandoned by the next start, while a
  // part file is a download the user can still resume.
  override fun load(webView: WebView) {
    super.load(webView)
    worker.execute {
      updateDir.listFiles()?.filter { it.name.endsWith(".apk") }?.forEach { it.delete() }
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
      val apk = File(updateDir, "${job.stem}.apk")
      if (!part.renameTo(apk)) throw UpdateFailure("storage")
      publish(job, Status("waiting-foreground", job.size, job.size))
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
    val apk = File(dir, "${job.stem}.apk")
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
