# In-app Updates for Community Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Community builds show their version and any newer release on the main screen; on Android, tapping
the green pill downloads the release APK inside the app, verifies it, and opens Android's install prompt.

**Architecture:** `releaseCheck.ts` grows to return the release notes and the APK asset. A small Zustand store
(`useAppUpdate`) owns the update state for the whole app. A version line above the user panel and a popup
(bottom sheet on touch, dialog with a mouse) read that store. On Android the store drives a new Tauri plugin,
`app-update`, whose Kotlin side downloads into the app cache with resume, checks size and SHA-256, and installs
through a `PackageInstaller` session, reporting every state change as an `update` event.

**Tech Stack:** React 19 + TypeScript, Zustand, Lingui, Vitest; Tauri 2 mobile plugin (Rust shim + Kotlin,
Android minSdk 24 / targetSdk 36).

**Spec:** `docs/superpowers/specs/2026-11-13-android-in-app-update-design.md`

## Global Constraints

- Work in a worktree of its own on branch `feat/android-in-app-update`; never bare `git stash`; never push or
  open a PR unprompted.
- Prefix vitest/tsc/vite/gradle/cargo with `nice -n 19`; vitest with `--maxWorkers=4`; the full suite runs once,
  at the end (Task 7). Lefthook from a shell: add `--no-tty`.
- Commits: one line, conventional with scope, no AI attribution (`timeout 180 git commit -q -m "…"`).
- Every new UI string goes through Lingui and is translated in all 18 locales (cs de es fi fr it ja ko nl pl pt
  ro ru sv tr uk zh zh-TW); `npm run i18n:extract` must report 0 missing, then `npm run i18n:compile`.
- Comments follow CLAUDE.md: why, not what; first person plural; no history.
- The feature exists only when `__APP_RELEASES_REPO__` is non-empty. The releases API base is
  `__APP_RELEASES_API__`, from `OBBY_RELEASES_API`, default `https://api.github.com`.
- Network: only the releases API, `github.com` and hosts ending in `.githubusercontent.com` (plus the API base's
  own host, so a test build can serve its own files). HTTPS only. The SHA-256 from the asset's `digest`
  (`sha256:<hex>`) must match before anything installs.
- Remote text (release notes) is never spliced into the app's own sentences; it sits in its own box.
- No foreground service, no notification about updates, no popup that opens by itself.
- Android: `REQUEST_INSTALL_PACKAGES` declared unconditionally; downloads live in `cacheDir/update/`.

## Review Focus

- **A release cache written by an older build** (`localStorage` `obby.releaseCheck` with no notes or APK): the
  app must ask again, not crash or offer an update with no file. Test in Task 1.
- **A release with no APK, or with several `.apk` files:** no APK means the popup's error state, never a hidden
  pill; several means `Obby-<version>.apk` wins. Test in Task 1.
- **Update tapped twice, or the sheet reopened mid-download:** one download only; the sheet shows the running
  one. Tests in Task 2 (store) and Task 3 (`startDownload` while running).
- **A server that answers a resume with `200` instead of `206`:** start over from byte 0, never append a whole
  file to a partial one. Test in Task 3 (`resumeDecision`).
- **A long nick, a custom status, a narrow sidebar:** the pill never covers or shifts other text. Test in Task 5,
  plus the visual check in Task 7.

---

### Task 1: Release check returns notes and the APK asset

**Files:**

- Modify: `src/lib/releaseCheck.ts`, `vite.config.ts:186-191`, `src/vite-env.d.ts` (or wherever
  `__APP_RELEASES_REPO__` is declared)
- Test: `tests/lib/releaseCheck.test.ts`

**Interfaces:**

- Produces:
  - `interface ApkAsset { name: string; size: number; sha256: string; url: string }` (`sha256` lowercase hex,
    no prefix)
  - `interface LatestRelease { version: string; url: string; notes: string; apk: ApkAsset | null }`
  - `function pickApkAsset(assets: unknown, version: string): ApkAsset | null`
  - `function shortReleaseLabel(version: string): string` (`"0.4.0-cf1.2.1"` → `"cf1.2.1"`; anything else returned
    as is)
  - `newerRelease({ repo, api, current, now, fetchImpl, force }?: …): Promise<LatestRelease | null>`; `force`
    skips the daily cache; `api` defaults to `__APP_RELEASES_API__`
  - `const RELEASES_API: string` (= `__APP_RELEASES_API__`)

- [ ] **Step 1: Write the failing tests** in `tests/lib/releaseCheck.test.ts` (keep the existing ones, adapt
      their expected objects to the new shape):
  - `"reads the notes and the APK asset"`: a body with `tag_name: "v0.4.0-cf1.2.1"`, `body: "## What's Changed"`,
    `assets: [{ name: "Obby-0.4.0-cf1.2.1.apk", size: 83105584, digest: "sha256:F68A…", browser_download_url:
"https://github.com/o/r/releases/download/v0.4.0-cf1.2.1/Obby-0.4.0-cf1.2.1.apk" }]` gives
    `apk.sha256` lowercased and `notes === "## What's Changed"`.
  - `"picks the APK named for the version when there are several"`: `["Obby-0.4.0-cf1.2.1.apk",
"Obby-debug.apk"]` → the first; with only `"other.apk"` → that one; with none, or an asset whose digest is
    missing or not `sha256:` → `null`.
  - `"asks again when the cache comes from an older build"`: seed `localStorage["obby.releaseCheck"]` with the
    old shape (`{repo, checkedAt: now, latest: {version, url}}`) and assert `fetchImpl` is called.
  - `"asks again when forced"`: a fresh cache plus `force: true` → `fetchImpl` called.
  - `"asks the configured API"`: `api: "https://test.example"` → request URL
    `https://test.example/repos/o/r/releases/latest`.
  - `shortReleaseLabel("0.4.0-cf1.2.1") === "cf1.2.1"`.

- [ ] **Step 2: Run them to see them fail**
      Run: `nice -n 19 npx vitest run tests/lib/releaseCheck.test.ts --maxWorkers=4`
      Expected: FAIL (`pickApkAsset` is not exported; objects lack `notes`/`apk`).

- [ ] **Step 3: Implement.** Store the cache under a new key `obby.releaseCheck.v2` (the old key is ignored, so
      an old entry means "ask again"). Add `'__APP_RELEASES_API__': JSON.stringify(process.env.OBBY_RELEASES_API ??
"https://api.github.com")` next to `__APP_RELEASES_REPO__` in `vite.config.ts`, and its `declare const`.

- [ ] **Step 4: Run them to see them pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit** — `feat(updates): read the notes and the APK asset of the newest release`

---

### Task 2: The update store and the native bridge

**Files:**

- Create: `src/store/appUpdate.ts`, `src/lib/appUpdateNative.ts`
- Test: `tests/store/appUpdate.test.ts`

**Interfaces:**

- Consumes: `newerRelease`, `LatestRelease`, `RELEASES_API` (Task 1); `isTauriAndroid` (`src/lib/platformUtils.ts`).
- Produces (`src/lib/appUpdateNative.ts`, plugin name `"app-update"`):
  - `type UpdatePhase = "idle" | "downloading" | "verifying" | "waiting-foreground" | "needs-permission" |
"installing" | "error"`
  - `type UpdateError = "network" | "no-apk" | "checksum" | "incompatible" | "refused" | "storage"`
  - `interface NativeUpdateEvent { phase: UpdatePhase; received: number; total: number; error: UpdateError |
null }`
  - `startDownload(args: { url: string; sha256: string; size: number; version: string; allowedHosts: string[] }):
Promise<NativeUpdateEvent>` → `invoke("plugin:app-update|start_download", args)`
  - `cancelDownload(): Promise<void>`, `downloadStatus(): Promise<NativeUpdateEvent>`,
    `openInstallSettings(): Promise<void>`, `retryInstall(): Promise<NativeUpdateEvent>`
  - `onUpdateEvent(cb: (e: NativeUpdateEvent) => void): Promise<PluginListener>` →
    `addPluginListener("app-update", "update", cb)`
  - `allowedUpdateHosts(api = RELEASES_API): string[]` → `["github.com", ".githubusercontent.com", <api host>]`
    (a leading dot means "this suffix")
- Produces (`src/store/appUpdate.ts`): `useAppUpdate` (Zustand `create`) with state
  `{ latest: LatestRelease | null; isOpen: boolean; phase: UpdatePhase; received: number; total: number;
error: UpdateError | null; isChecking: boolean }` and actions `check(opts?: { force?: boolean }): Promise<void>`,
  `openSheet()`, `closeSheet()`, `startUpdate(): Promise<void>`, `cancelUpdate(): Promise<void>`,
  `continueAfterPermission(): Promise<void>` (opens the Android setting), `retry(): Promise<void>`,
  `applyNative(e: NativeUpdateEvent)`, and `selectCanInstallInApp(state): boolean` (Android and `latest.apk`).
  `closeSheet` never cancels a download. On Android, the store subscribes to `onUpdateEvent` once and calls
  `downloadStatus()` on first use, so a download survives the sheet and reflects a running one.

- [ ] **Step 1: Write the failing tests** (mock `../../src/lib/appUpdateNative` and `../../src/lib/releaseCheck`;
      fake `isTauriAndroid`):
  - `"check stores the newer release and nothing when there is none"`.
  - `"startUpdate on Android asks the plugin once, even when tapped twice"`: two `startUpdate()` calls → one
    `startDownload` call with `{ url, sha256, size, version, allowedHosts: ["github.com", ".githubusercontent.com",
"api.github.com"] }`.
  - `"a release without an APK goes to the no-apk error instead of downloading"`.
  - `"closing the sheet keeps the download"`: `startUpdate()`, `closeSheet()` → `cancelDownload` not called,
    `phase === "downloading"`.
  - `"native events update the progress"`: `applyNative({ phase: "downloading", received: 10, total: 100, error:
null })` → state matches.
  - `"outside Android, startUpdate does not touch the plugin"`.

- [ ] **Step 2: Run them to see them fail** — `nice -n 19 npx vitest run tests/store/appUpdate.test.ts
--maxWorkers=4` → FAIL (modules missing).

- [ ] **Step 3: Implement** both files to the interfaces above. Errors from `invoke` map to `phase: "error"`,
      `error: "network"` unless the plugin sent a code.

- [ ] **Step 4: Run them to see them pass** (same command) → PASS.

- [ ] **Step 5: Commit** — `feat(updates): keep the update state in one store`

---

### Task 3: Android plugin, download with resume and verification

**Files:**

- Create: `src-tauri/plugins/app-update/{Cargo.toml,build.rs,src/lib.rs,permissions/default.toml}`,
  `src-tauri/plugins/app-update/android/{build.gradle.kts,settings.gradle,proguard-rules.pro,.gitignore}`,
  `…/android/src/main/AndroidManifest.xml`, `…/android/src/main/java/AppUpdatePlugin.kt`,
  `…/android/src/main/java/UpdateRules.kt`, `…/android/src/test/java/UpdateRulesTest.kt`,
  `src-tauri/capabilities/android.json`
- Modify: `src-tauri/Cargo.toml` (new `[target.'cfg(target_os = "android")'.dependencies]` entry
  `tauri-plugin-app-update = { path = "plugins/app-update" }`), `src-tauri/src/lib.rs` (register inside the
  existing `#[cfg(target_os = "android")]` block)

**Interfaces:**

- Consumes: the command names and `NativeUpdateEvent` shape from Task 2 (camelCase JSON:
  `{ phase, received, total, error }`).
- Produces: plugin `app-update`, Kotlin package `world.obby.appupdate`, class `AppUpdatePlugin`; commands
  `start_download`, `cancel_download`, `download_status`, `open_install_settings`, `retry_install`,
  `register_listener` (all in `build.rs` `COMMANDS` and `permissions/default.toml`); event `"update"`. Pure
  helpers in `UpdateRules.kt`:
  - `fun isAllowedHost(host: String, allowed: List<String>): Boolean` (exact match, or suffix for entries
    starting with `.`; case-insensitive)
  - `sealed class Resume { object FromStart; data class Append(val offset: Long) }` and
    `fun resumeDecision(partLength: Long, httpStatus: Int, contentRangeStart: Long?): Resume`
  - `fun sha256Matches(actualHex: String, expectedHex: String): Boolean`

Model the crate on `src-tauri/plugins/mobile-notifications` (same `Cargo.toml` shape, `build.rs` with
`.android_path("android")` and no iOS path, `register_android_plugin("world.obby.appupdate", "AppUpdatePlugin")`,
`Native` handle). Commands go straight to Kotlin (no Rust command handlers), as `push_status` does today.
`capabilities/android.json`: `"platforms": ["android"]`, `"permissions": ["app-update:default"]`. The manifest
declares `android.permission.REQUEST_INSTALL_PACKAGES`.

- [ ] **Step 1: Check the Android toolchain.** Gradle needs the Android SDK (platform 36, build-tools 34.0.0), NDK
      r27 and a JDK Gradle 8.11 can run on (21 or 22). If any is missing, stop and ask before installing anything.

- [ ] **Step 2: Write the failing Kotlin unit tests** in `UpdateRulesTest.kt` (JUnit 4):
  - `isAllowedHost("release-assets.githubusercontent.com", listOf("github.com", ".githubusercontent.com"))` true;
    `"githubusercontent.com.evil.net"` false; `"GitHub.com"` true; `"evil-github.com"` false.
  - `resumeDecision(0, 200, null) == FromStart`; `resumeDecision(5000, 206, 5000) == Append(5000)`;
    `resumeDecision(5000, 200, null) == FromStart`; `resumeDecision(5000, 206, 4000) == FromStart`.
  - `sha256Matches("ABCD", "abcd")` true; `sha256Matches("abcd", "abce")` false.

- [ ] **Step 3: Run them to see them fail** — from `src-tauri/gen/android`:
      `nice -n 19 ./gradlew :tauri-plugin-app-update:testDebugUnitTest` (run `npx tauri android build` once first if
      the generated `tauri.settings.gradle` does not list the plugin yet) → FAIL (unresolved references).

- [ ] **Step 4: Implement `UpdateRules.kt`, then the download half of `AppUpdatePlugin.kt`:**
  - `startDownload(invoke)`: parse `{url, sha256, size, version, allowedHosts}`. If a download is already
    running for the same version, resolve with its current status and start nothing. Delete every file in
    `cacheDir/update/` that is not `<version>.apk.part`. Download on a single worker thread: HTTPS only, follow
    redirects by hand (at most 5), checking `isAllowedHost` on every hop; `Range: bytes=<partLength>-` when a
    part file exists, then `resumeDecision`. Emit `update` events at most 4 per second while downloading.
  - After the last byte: `verifying`; size must equal `size` and `sha256Matches` the expected hash, else delete
    the part file and emit `error`/`checksum`. On success rename to `<version>.apk` (the install half takes it
    from there in Task 4; until then emit `waiting-foreground`).
  - `cancelDownload`: stop the thread and delete the part file → `idle`. `downloadStatus`: the current event.
  - Network failures → `error`/`network` with the part file kept (the next start resumes). Disk failures →
    `error`/`storage`.
  - `load()`: delete every finished `*.apk` in `cacheDir/update/` (an installed or abandoned update); keep
    `.part` files.

- [ ] **Step 5: Run the unit tests to see them pass** (same Gradle command) → PASS; then
      `nice -n 19 npx tauri android build --apk --debug` (with `OBBY_RELEASES_REPO=test/obby`) succeeds, and
      `nice -n 19 cargo clippy --manifest-path src-tauri/plugins/app-update/Cargo.toml` and `cargo fmt --check` are
      clean.

- [ ] **Step 6: Commit** — `feat(android): download a release APK with resume and a checksum`

---

### Task 4: Android plugin, install through PackageInstaller

**Files:**

- Modify: `src-tauri/plugins/app-update/android/src/main/java/AppUpdatePlugin.kt`

**Interfaces:**

- Consumes: the verified `<version>.apk` from Task 3, the event shape from Task 2.
- Produces: phases `needs-permission`, `waiting-foreground`, `installing`, and errors `incompatible`,
  `refused`; commands `open_install_settings`, `retry_install`.

- [ ] **Step 1: Implement the install half:**
  - After verification: on API 26+ when `packageManager.canRequestPackageInstalls()` is false → emit
    `needs-permission`. `openInstallSettings` starts `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` with
    `package:<our package>` (API 24–25: `Settings.ACTION_SECURITY_SETTINGS`).
  - Only while the activity is resumed: open a `PackageInstaller` session (`MODE_FULL_INSTALL`), copy the APK in,
    commit with a `PendingIntent` to a receiver registered at runtime (`RECEIVER_NOT_EXPORTED` on API 33+, the
    `PendingIntent` `FLAG_MUTABLE` so the system can add its extras). Otherwise emit `waiting-foreground`.
  - `onResume()`: if the state is `needs-permission` and permission is now granted, or `waiting-foreground`,
    continue the install by itself.
  - Session status: `STATUS_PENDING_USER_ACTION` → start `EXTRA_INTENT` (`FLAG_ACTIVITY_NEW_TASK`), emit
    `installing`; `STATUS_FAILURE_INCOMPATIBLE` or `STATUS_FAILURE_CONFLICT` → `error`/`incompatible`;
    `STATUS_FAILURE_ABORTED` (user tapped Cancel) → `error`/`refused` with the APK kept; any other failure →
    `error`/`refused`. `retryInstall` re-runs the install from the kept APK.

- [ ] **Step 2: Verify the build** — the same `tauri android build --apk --debug`, clippy, fmt and Gradle unit
      tests as Task 3 Step 5 → all pass. (Behaviour is checked on the phone in Task 7.)

- [ ] **Step 3: Commit** — `feat(android): install a verified update through the system installer`

---

### Task 5: The version line and the pill

**Files:**

- Create: `src/components/layout/UpdateLine.tsx`
- Modify: `src/components/layout/ChannelList.tsx:702` (render `<UpdateLine />` directly before `<UserPanel …/>`),
  `src/index.css` (next to `.user-panel`)
- Test: `tests/components/layout/UpdateLine.test.tsx`

**Interfaces:**

- Consumes: `useAppUpdate` (Task 2), `APP_VERSION` (`src/lib/appVersion.ts`), `__APP_COMMIT__`,
  `shortReleaseLabel` (Task 1).
- Produces: `UpdateLine` (no props). On mount it calls `useAppUpdate.getState().check()` and again on
  `visibilitychange` to visible (the daily cache keeps that cheap).

- [ ] **Step 1: Write the failing tests:**
  - `"always shows the version"`: text `Obby 0.4.0-cf1.2.0 · <commit>` present with no release.
  - `"shows the pill only when a newer release exists"`; `"hides the pill when checkForReleases is off"`.
  - `"labels the pill with the release"`: wide label `↑ Update to cf1.2.1`, narrow label `↑ Update`, and during a
    download `↓ 46%` (`received 46, total 100`).
  - `"tapping the pill opens the popup; the version text does nothing"`.
  - `"the pill never shrinks and the version gives way first"`: the pill has `shrink-0` and `whitespace-nowrap`,
    the version span has `min-w-0` and `truncate`.

- [ ] **Step 2: Run them to see them fail** — `nice -n 19 npx vitest run
tests/components/layout/UpdateLine.test.tsx --maxWorkers=4` → FAIL.

- [ ] **Step 3: Implement.** One row, `mx-2 h-5 flex items-center gap-1.5 px-1`, version in `row-meta`; the pill
      green (`bg-discord-green text-white rounded-full px-2 text-[11px] font-semibold`), 44px tap area on touch input
      (`after:` inset, as `ServerList`'s reconnect button does). The wide/narrow labels and the long/short version
      switch on a container query: `.update-line { container-type: inline-size }`, wide forms shown from
      `@container (min-width: 220px)`.

- [ ] **Step 4: Run them to see them pass** (same command) → PASS.

- [ ] **Step 5: Commit** — `feat(updates): show the version and a new release above the user panel`

---

### Task 6: The popup, Settings and the release text

**Files:**

- Create: `src/components/ui/UpdateSheet.tsx`, `src/components/ui/settings/UpdateCheckField.tsx`
- Modify: `src/components/layout/AppLayout.tsx` (mount `<UpdateSheet />` once), `src/components/pages/SettingsPage.tsx`
  (`AppVersion` reads `useAppUpdate` and its button calls `openSheet()`; its own fetch goes),
  `src/lib/settings/definitions/allSettings.ts` (reworded `checkForReleases`; new `preferences.checkNow` custom
  row with `UpdateCheckField`), `.github/workflows/publish-community.yaml:70`, `docs/community-releases.md:84`,
  `CLAUDE.md` (the "do not add an in-app updater" line), `src/locales/*`
- Test: `tests/components/ui/UpdateSheet.test.tsx`

**Interfaces:**

- Consumes: `useAppUpdate`, `selectCanInstallInApp` (Task 2), `BottomSheet`, `BaseModal`, `useIsTouchInput`,
  `ExternalLinkWarningModal`.
- Produces: `UpdateSheet` (no props; open while `useAppUpdate.isOpen`).

Exact copy (English source strings):

- Offer: title `Obby {version}`; line `You have {current} · {size} download`; notes box heading `Release notes`;
  closing note `Obby will close to install the update; open it again afterwards.`; buttons `Update`
  (`Download` when not installable in-app), `Not now`; link `Open the release page`.
- Downloading: `Downloading {label}`, `{received} of {total}`, hint `You can close this and keep chatting.`,
  button `Cancel`.
- Verifying: `Checking the download`.
- Permission: `Allow Obby to install updates`, `Android asks once. Turn on "Allow from this source" for Obby,
then come back; the update continues by itself.`, buttons `Open Android settings`, `Not now`.
- Waiting: `Ready to install. Return to Obby to continue.` (shown only if the sheet is open while that state
  lasts).
- Errors, title `Update not installed`, then by code: network `The download stopped. Check your connection
and try again.`; no-apk `This release has no Android app to install.`; checksum `The download did not match
the release's checksum, so it was thrown away.`; incompatible `Android refused the update because it was
signed by someone else. Install it from the release page.`; refused `The install was cancelled.`; storage
  `There is not enough free space for the update.` Buttons `Try again`, `Close`, link `Open the release page`.
- Settings: `checkForReleases` description `Once a day, ask the project's release page whether a newer build
exists and show it above your name. Nothing is downloaded until you tap Update.`; Check now row title
  `Check for an update now`, button `Check now`, result lines `Obby is up to date.` / `Obby {version} is
available.`
- Release body opening (workflow): `Community build of Obby. The Android app updates itself from inside the
app; desktop apps do not, so download the next release from here.` The docs line says the same.
- CLAUDE.md: after the "do not add an in-app updater" sentence add `Community builds are the exception: they are
sideloaded, so Android updates itself from the release APK (see
docs/superpowers/specs/2026-11-13-android-in-app-update-design.md).`

- [ ] **Step 1: Write the failing tests** (store seeded per state, `isTauriAndroid` faked):
  - `"offers the update with size and notes"`: `79 MB`, the notes text inside the `Release notes` box,
    `Update` button.
  - `"outside Android, Download opens the release page through the link warning"`.
  - `"shows progress and cancels"`: `36 of 79 MB`, progress bar `aria-valuenow` 46, `Cancel` →
    `cancelUpdate`.
  - `"asks for the install permission and opens the setting"`.
  - One test per error code asserting its exact message and that `Try again` calls `retry`.
  - `"is a bottom sheet on touch input and a dialog with a mouse"`.

- [ ] **Step 2: Run them to see them fail** — `nice -n 19 npx vitest run tests/components/ui/UpdateSheet.test.tsx
--maxWorkers=4` → FAIL.

- [ ] **Step 3: Implement** `UpdateSheet`, `UpdateCheckField`, the Settings and copy changes. Sizes through
      the existing byte formatter if the codebase has one (search `formatBytes`/`formatFileSize`), else MB with
      one decimal. The progress bar is a real `role="progressbar"` with `aria-valuemin/max/now`.

- [ ] **Step 4: Run them to see them pass** (same command) → PASS. Then `npm run i18n:extract`, translate
      every new string in all 18 locales, `npm run i18n:compile`; extract shows 0 missing.

- [ ] **Step 5: Commit** — `feat(updates): update popup, Check now in Settings and the release text`

---

### Task 7: Whole-branch checks and the phone test

**Files:**

- Create (in a temporary directory, not committed): a stand-in release API directory and a local keystore.

- [ ] **Step 1: CI gate** in the worktree: `npx lefthook run pre-commit --no-tty --commands check --all-files`,
      `… --commands i18n --all-files`, `… --commands docs-format,docs-lint --all-files`,
      `… --commands rust-fmt,rust-clippy --all-files`, `nice -n 19 npm run build`,
      `nice -n 19 npx vitest run --maxWorkers=4` → every exit code 0, `git status` clean.

- [ ] **Step 2: Visual check** in a browser against a debug build with the store injected: a
      release injected into `useAppUpdate`; screenshots at 1280 px and 400 px with a long nick, a custom away
      status, pronouns and a network name → the pill never overlaps or shifts the panel's text; the version line
      truncates first.

- [ ] **Step 3: Build two test APKs with one key.** `keytool -genkeypair` a throwaway keystore; build
      `OBBY_RELEASE=cf9.0.0` (versionCode `4009000`) and `OBBY_RELEASE=cf9.0.1` (versionCode `4009001`), both with
      `OBBY_RELEASES_REPO=test/obby` and `OBBY_RELEASES_API=https://<test-host>`, via
      `npm run tauri android build -- --apk --config '{"identifier":"<identifier from tauri.conf.json>.updatetest","bundle":{"android":{"versionCode":…}}}'`
      (its own app id, so it installs beside the real Obby instead of over it); sign each with
      `apksigner` as `publish-community.yaml` does.

- [ ] **Step 4: Serve the stand-in API to the phone.** In the temporary directory, `repos/test/obby/releases/latest`
      (JSON with `tag_name: "v0.4.0-cf9.0.1"`, `body`, and one asset whose `size`, `digest: "sha256:<sha256sum>"`
      and `browser_download_url` point at the cf9.0.1 APK under the same host), plus both APKs; a small local HTTP server behind an HTTPS front with a real certificate, turned off again
      afterwards.

- [ ] **Step 5: Run the flow on the phone:** open the cf9.0.0 APK link in the phone's
      browser and install it; in Obby, the version line shows `0.4.0-cf9.0.0` and a pill `↑ Update to cf9.0.1`;
      tap it → offer → Update → progress → permission step (first time) → Android's prompt → Obby closes; reopen →
      `0.4.0-cf9.0.1`, no pill. Then: a second run with the network cut mid-download resumes; a stand-in digest
      changed by one character gives the checksum error. Record what was seen.

- [ ] **Step 6: Clean up** — stop the server and its HTTPS front, delete the throwaway keystore and APKs, and
      uninstall the separate "updatetest" app; the real Obby was never touched.
