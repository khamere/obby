package world.obby.appupdate

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
