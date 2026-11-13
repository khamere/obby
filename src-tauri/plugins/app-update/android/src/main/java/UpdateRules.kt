package world.obby.appupdate

import android.content.pm.PackageInstaller
import java.util.Locale

/** Whether we may download from [host]: an exact entry, or any host ending in an entry that starts with a dot. */
fun isAllowedHost(host: String, allowed: List<String>): Boolean {
  val name = host.lowercase(Locale.ROOT)
  if (name.isEmpty()) return false
  return allowed.any { entry ->
    val rule = entry.lowercase(Locale.ROOT)
    if (rule.startsWith(".")) name.endsWith(rule) else name == rule
  }
}

sealed class Resume {
  object FromStart : Resume()
  data class Append(val offset: Long) : Resume()
}

/** Appends to the part file only when the server answers our range with bytes that start exactly where it ends. */
fun resumeDecision(partLength: Long, httpStatus: Int, contentRangeStart: Long?): Resume =
  if (partLength > 0 && httpStatus == 206 && contentRangeStart == partLength) {
    Resume.Append(partLength)
  } else {
    Resume.FromStart
  }

/** The first byte of a `Content-Range: bytes <start>-<end>/<size>` header. */
fun contentRangeStart(header: String?): Long? =
  header?.let { Regex("""^\s*bytes\s+(\d+)-\d+/(\d+|\*)\s*$""", RegexOption.IGNORE_CASE).find(it) }
    ?.groupValues
    ?.get(1)
    ?.toLongOrNull()

fun sha256Matches(actualHex: String, expectedHex: String): Boolean =
  expectedHex.isNotEmpty() && actualHex.equals(expectedHex, ignoreCase = true)

sealed class InstallOutcome {
  object NeedsUser : InstallOutcome()
  object Installed : InstallOutcome()
  data class Failed(val code: String) : InstallOutcome()
}

/** What a PackageInstaller session status means for the update; every failure we cannot name is Android refusing it. */
fun installOutcome(status: Int): InstallOutcome =
  when (status) {
    PackageInstaller.STATUS_PENDING_USER_ACTION -> InstallOutcome.NeedsUser
    PackageInstaller.STATUS_SUCCESS -> InstallOutcome.Installed
    PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, PackageInstaller.STATUS_FAILURE_CONFLICT ->
      InstallOutcome.Failed("incompatible")
    else -> InstallOutcome.Failed("refused")
  }
