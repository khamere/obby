package world.obby.appupdate

import android.content.pm.PackageInstaller
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

  @Test
  fun mapsInstallerStatusesToOutcomes() {
    assertEquals(InstallOutcome.NeedsUser, installOutcome(PackageInstaller.STATUS_PENDING_USER_ACTION))
    assertEquals(InstallOutcome.Installed, installOutcome(PackageInstaller.STATUS_SUCCESS))
    assertEquals(InstallOutcome.Failed("incompatible"), installOutcome(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE))
    assertEquals(InstallOutcome.Failed("incompatible"), installOutcome(PackageInstaller.STATUS_FAILURE_CONFLICT))
    assertEquals(InstallOutcome.Failed("refused"), installOutcome(PackageInstaller.STATUS_FAILURE_ABORTED))
    assertEquals(InstallOutcome.Failed("refused"), installOutcome(PackageInstaller.STATUS_FAILURE))
    assertEquals(InstallOutcome.Failed("refused"), installOutcome(PackageInstaller.STATUS_FAILURE_BLOCKED))
    assertEquals(InstallOutcome.Failed("refused"), installOutcome(PackageInstaller.STATUS_FAILURE_INVALID))
    assertEquals(InstallOutcome.Failed("refused"), installOutcome(PackageInstaller.STATUS_FAILURE_STORAGE))
    assertEquals(InstallOutcome.Failed("refused"), installOutcome(12345))
  }
}
