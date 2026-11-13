package world.obby.appupdate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {
  private val hosts = listOf("github.com", ".githubusercontent.com")

  @Test
  fun allowsTheReleaseHosts() {
    assertTrue(isAllowedHost("release-assets.githubusercontent.com", hosts))
    assertTrue(isAllowedHost("GitHub.com", hosts))
  }

  @Test
  fun refusesLookalikeHosts() {
    assertFalse(isAllowedHost("githubusercontent.com.evil.net", hosts))
    assertFalse(isAllowedHost("evil-github.com", hosts))
    assertFalse(isAllowedHost("", hosts))
  }

  @Test
  fun resumesOnlyWhenTheServerContinuesAtThePartLength() {
    assertEquals(Resume.FromStart, resumeDecision(0, 200, null))
    assertEquals(Resume.Append(5000), resumeDecision(5000, 206, 5000))
    assertEquals(Resume.FromStart, resumeDecision(5000, 200, null))
    assertEquals(Resume.FromStart, resumeDecision(5000, 206, 4000))
  }

  @Test
  fun readsTheStartOfAContentRange() {
    assertEquals(5000L, contentRangeStart("bytes 5000-9999/10000"))
    assertNull(contentRangeStart("bytes */10000"))
    assertNull(contentRangeStart(null))
  }

  @Test
  fun comparesHashesWithoutCase() {
    assertTrue(sha256Matches("ABCD", "abcd"))
    assertFalse(sha256Matches("abcd", "abce"))
    assertFalse(sha256Matches("", ""))
  }
}
