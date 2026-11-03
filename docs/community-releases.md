# Community releases

The `community-fixes` branch is where every fix lands. Releases are cut from
`community-fixes-release`, which only ever moves forward to a commit of
`community-fixes` that has been running for a while without complaints.

A release is a tag `cf-v<version>` on `community-fixes-release`, where
`<version>` is the version in `package.json`. Pushing that tag runs
[`publish-community.yaml`](../.github/workflows/publish-community.yaml), which
builds and attaches to a GitHub release:

- Linux: `.deb`, `.rpm` and AppImage for x64 and arm64
- Windows: `.msi` and `.exe` installers
- macOS: `.dmg` for Apple silicon and Intel, unsigned (right-click, Open)
- Android: signed `.apk` and `.aab`
- Web: `Obby-<version>-web.zip` with the built `dist/`
- Docker: `ghcr.io/<owner>/obby:<version>` and `:latest` for amd64 and arm64

Upstream's `publish.yaml` is left as is, so merges from upstream stay clean.
iOS and Google Play are not built: both need accounts the fork does not have.

## Cutting a release

1. Bump `version` in `package.json` on `community-fixes` through a pull request
   (`chore(release): 0.4.1`). Keep to plain `major.minor.patch`; the Android
   version code is derived from it.
2. Fast-forward the release branch and tag it:

   ```sh
   git fetch origin
   git checkout community-fixes-release
   git merge --ff-only origin/community-fixes
   git tag cf-v0.4.1
   git push origin community-fixes-release cf-v0.4.1
   ```

3. Watch the run under Actions. The release appears on the Releases page as
   `Obby cf-v0.4.1` with generated notes since the previous `cf-v` release.

If the tag does not match `cf-v` plus the `package.json` version, the run stops
in its first job before building anything.

## One-time setup

- Actions must be enabled for the repository (forks start with them off).
- Android signing needs three repository secrets. Make a keystore once and keep
  it; a later release signed with a different key cannot update an installed
  app:

  ```sh
  keytool -genkeypair -v -keystore obby-community.jks -alias obby \
    -keyalg RSA -keysize 4096 -validity 10000
  base64 -w0 obby-community.jks > obby-community.jks.base64
  ```

  | Secret                     | Value                                   |
  | -------------------------- | --------------------------------------- |
  | `ANDROID_RELEASE_KEYSTORE` | contents of `obby-community.jks.base64` |
  | `ANDROID_RELEASE_KEY`      | the alias, `obby` above                 |
  | `ANDROID_RELEASE_PASSWORD` | the keystore password                   |

  Without them the Android job fails and every other job still publishes.

- The package `ghcr.io/<owner>/obby` is created private on the first push.
  Make it public in the package settings if the image is meant for others.

## What the builds do not do

- Desktop apps do not update themselves. Their updater is pointed at this
  repository, where no update manifest exists, so the check stays quiet.
  Signed updater artifacts would need a Tauri signing key pair, with the public
  key in `tauri.conf.json` and the private key as a secret.
- The Android app keeps upstream's application id. A phone with the upstream
  app installed refuses this one, and the other way round, because the
  signatures differ.
