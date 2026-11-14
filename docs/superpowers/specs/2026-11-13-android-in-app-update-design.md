# In-app updates for community builds

## Why

Community releases are signed APKs on the GitHub release page, not on Google Play. Updating Obby on a phone
today means noticing the release, opening GitHub in a browser, downloading the APK and installing it by hand.
The user wants what other sideloaded Android apps (e.g. Morphe) do: tap Update inside the app, watch it
download, and get Android's install prompt right after. Separately, the running version and the existence of an
update must be visible on the main screen, not only at the bottom of Settings.

## Goals

- Android: tap the update pill, see what's new, tap Update, watch the download, get Android's install prompt
  as soon as the APK is downloaded and verified. No browser, no GitHub page.
- Every platform: the running version is always visible on the main screen, and an update shows there as a
  green pill.
- The popup opens only when the user taps the pill.

## Non-goals

- Silent or automatic installs. Android always shows its own prompt for a sideloaded app, and that stays.
- Opening the popup by itself on launch, or notifications about updates.
- In-app install on desktop, iOS or web. Desktop and web show the same pill and popup; there "Update" opens the
  release page.
- Google Play builds. They keep updating through Play.
- Downgrades, choosing a release channel or picking an older release.

## Anti-goals (a failure even if it technically works)

- The pill overlaps or pushes out any existing text in the user panel (nick, status, username, pronouns,
  network).
- Installing a file that is not the release's APK: anything that skips the checksum check, or follows a URL
  that did not come from the release's asset list.
- A download that leaves an 80 MB file behind in the user's Downloads or in the app cache after it is done or
  abandoned.
- Network requests to anything other than the GitHub API and the release asset download (CLAUDE.md "URL
  Safety").

## Constraints

- **CLAUDE.md exception.** CLAUDE.md says "Mobile updates ship through the App Store / Google Play: do not add
  an in-app updater for iOS/Android". This feature is a deliberate exception for community builds, which are
  sideloaded. It exists only when the build names a releases repository (`OBBY_RELEASES_REPO`, set by
  `publish-community.yaml` and the Dockerfile); Google Play and upstream builds have none and never show it.
  The CLAUDE.md line gets a sentence saying so.
- **Android facts:** minSdk 24, targetSdk 36. Installing needs `REQUEST_INSTALL_PACKAGES` and the user's
  per-app "install unknown apps" permission (API 26+; on 24 and 25 the global "Unknown sources" switch).
  Android refuses an update signed with another key or with a lower version code.
- **Release facts:** every community release has exactly one `Obby-<version>.apk` asset (about 80 MB), and the
  GitHub API gives each asset a `digest` of the form `sha256:<hex>`, a `size` and a `browser_download_url` on
  `github.com` that redirects to a `*.githubusercontent.com` host (today `release-assets.githubusercontent.com`).
- Every new UI string is translated in all 18 locales (CLAUDE.md i18n rules); UI follows CLAUDE.md "UI
  conventions" (`BottomSheet` on touch, `BaseModal` dialogs, `discord-*` tokens, 44px touch targets,
  `tooltip-surface` hints, `LoadingSpinner` only for blocking waits, a real progress bar for known sizes).

## Approaches considered

- **A. Native download and install (picked).** A Kotlin plugin downloads the APK into the app's private cache
  with progress events, checks its SHA-256, and hands it to Android's `PackageInstaller`. Most control: progress
  in the popup, verification before install, nothing left in Downloads.
- **B. Android `DownloadManager`.** Less code, but progress lives in the notification shade, the APK lands in
  public Downloads and stays there, and verification is harder to put between download and install.
- **C. Download in the web layer and hand the file to native code.** Dropped: 80 MB through the webview bridge
  is slow and memory-heavy on a phone.

The user picked A.

## What was decided

### Where the update shows (decided with mockups)

A slim **version line** of its own sits directly above the user panel in `ChannelList` (the panel itself is
unchanged). Left: the version, `Obby 0.4.0-cf1.2.0 · 076d85ca` (`APP_VERSION` and `__APP_COMMIT__`), muted.
Right, only when a newer release exists: a green pill `↑ Update to cf1.2.1`. The pill never shrinks; the
version text truncates with an ellipsis first. On narrow widths (phone, narrow sidebar) the pill shortens to
`↑ Update` and the version drops "Obby" and the commit. Tapping the pill opens the popup; the version text does
nothing. While a download runs the pill reads `↓ 46%`.

The version line is shown on every build. The pill needs a releases repository and the
`checkForReleases` setting on.

### When it checks

Once a day, as `releaseCheck.ts` does today (cached in `localStorage` per repository and API base), plus a **Check now**
button in Settings → Updates. The existing Settings "New release" button opens the same popup (one entry point
per action). The `checkForReleases` description ("Nothing is downloaded or installed") is reworded: nothing is
downloaded until you tap Update.

### The popup

Opens only from the pill (or the Settings button). A `BottomSheet` on touch input, a `BaseModal` dialog with
a mouse.

1. **Offer:** title `Obby 0.4.0-cf1.2.1`, a line `You have 0.4.0-cf1.2.0 · 79 MB download`, the release notes,
   then **Update**, **Not now**, and a small "Open the release page" link (through `ExternalLinkWarningModal`).
2. **Downloading:** a real progress bar with `36 of 79 MB`, a **Cancel** button, and a hint that the sheet
   can be closed. Closing it does not stop the download; the pill shows the percentage and reopens the sheet.
3. **Checking:** the SHA-256 of the file against the asset's `digest`. Then straight to Android's install
   prompt.
4. **Done:** Android installs the update and closes Obby; it does not reopen it, and Obby posts no notification
   about it. The offer in step 1 says so up front ("Obby will close to install the update; open it again
   afterwards"). The next start shows the new version on the version line, and deletes the downloaded file.
5. **Permission (first time only):** "Allow Obby to install updates", explaining Android asks once, with
   **Open Android settings** (`ACTION_MANAGE_UNKNOWN_APP_SOURCES` for our package) and **Not now**. When the
   user comes back with the permission on, the update continues by itself.
6. **Error:** what happened in plain words (no network, the release has no APK, checksum mismatch, Android
   refused the install), with **Try again**, **Close** and the release-page link. One error comes from the
   app itself and not from the plugin: `not-ready` ("The update could not start. Try again."), shown when
   the plugin could not be listened to, so no download was started.

On desktop and web the popup shows step 1 with **Download** in place of **Update**, which opens the release
page through `ExternalLinkWarningModal`.

### Leaving the app during a download (decided)

No foreground service and no download notification. The download runs on a plugin worker thread for as long
as Android keeps the process alive (usually the whole time when the user has keep-alive on, since that keeps
Obby running). Android does not let a backgrounded app open the install prompt, so:

- a download that finishes while Obby is in the background waits, verified, and the install prompt opens as
  soon as Obby is back in front;
- a download that was interrupted (process killed, network lost) resumes from the bytes already in
  `cacheDir/update/` (HTTP `Range`) when the user next taps the pill, instead of starting over.

### How it is tested before a real release (decided)

The release key lives only in GitHub secrets, and Android installs an update only when both APKs carry the
same key. So the end-to-end check uses two locally built APKs signed with one debug key: version N (installed on the phone from a link, under its own app id so it sits beside the real
Obby) and version N+1, served from a local stand-in for the GitHub release API that the test
build points at (the releases API base is overridable at build time for this; community builds keep
`api.github.com`). That covers the whole flow on a real phone except the release key itself. The first
community release that carries the feature is installed by hand once; the release after it is the final check
with the real key.

### Calls made while writing this (builder's judgement, open to change)

- **Redirect host:** the downloader accepts HTTPS redirects only to hosts ending in `.githubusercontent.com`;
  the SHA-256 check is the real guarantee either way.
- **Permission in every Android build:** `REQUEST_INSTALL_PACKAGES` is declared unconditionally. This fork
  never builds for Google Play, and the feature itself only appears when a releases repository is set.
- **Release body:** `publish-community.yaml` opens every release with "Desktop apps do not update themselves;
  download the next release from here." That sentence is reworded (Android updates from inside the app;
  desktop downloads from here), along with the matching line in `docs/community-releases.md`. The popup shows
  the new release's notes, which already carry the new wording.

### Added during review and the phone test

- **Leaving Android's prompt unanswered:** the prompt lives outside the app, so the "installing" state offers
  **Show the install prompt again** and **Cancel**; nothing reopens the prompt by itself.
- **The version text steps down before it is cut:** full (`Obby 0.4.0-cf1.2.0 · 076d85ca`), then the version
  alone, then the community part (`cf1.2.0`), chosen by the width left beside the pill; a `title` keeps the full
  string.
- **A failed check is not "up to date":** a request that fails is not remembered for the day, keeps the release
  already known, and Settings says the check failed.
- **A check after a failed update takes the answer:** a release that changed (a republished file has a new
  checksum) clears the error, so the next attempt is measured against the new file.
- **Settings offers the update too:** the Check now row shows the known release with an **Update** button that
  opens the same popup.

## Left to the builder

- Whether the Kotlin code goes in a new small plugin (e.g. `src-tauri/plugins/app-update`) or in
  `mobile-notifications`. A new plugin is preferred for separation, if the wiring cost is small.
- The exact plugin commands and event names (`start`, `cancel`, `status`, a `progress` event via
  `trigger`), and how JS state survives the sheet being closed (a small store slice is the obvious fit).
- How the release check grows to return the APK asset (`name`, `size`, `digest`, `browser_download_url`) and
  the release `body`. `releaseCheck.ts` keeps its tests and its once-a-day cache.
- Rendering the release notes: GitHub's markdown body is shown as plain text (or through the app's existing
  markdown renderer with links going through the link warning), trimmed to a scrollable box. It is remote
  text, so it sits in a box headed as the release's notes, never spliced into the app's own sentences
  (CLAUDE.md "Never put English prose in state").
- The download (`HttpURLConnection` following the redirect, buffered write to `cacheDir/update/`, progress
  throttled to a few events a second) and the install (`PackageInstaller` session with a status
  `PendingIntent`; on `STATUS_PENDING_USER_ACTION` start the confirmation intent). Stale files in
  `cacheDir/update/` are removed on start.
- Which asset counts as "the APK": the one ending in `.apk`; if there are several, the one named
  `Obby-<version>.apk`. No APK means the error state, not a hidden pill.
- Tests: unit tests for the release check and the pill/popup states with the plugin mocked; Kotlin logic
  that can be pure (checksum, asset choice) kept testable. A real install on a phone with the community
  signing key is the final check (a debug build cannot update a release build, since the keys differ).
