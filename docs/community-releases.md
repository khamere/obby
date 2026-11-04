# Community releases

The `community-fixes` branch is where every fix lands. Releases are cut from
`community-fixes-release`, which only ever moves forward to a commit of
`community-fixes` that has been running for a while without complaints.

A release is a tag `v<version>-cf<a>.<b>.<c>` on `community-fixes-release`,
where `<version>` is the upstream version in `package.json` and `a.b.c` is the
community release on top of it: `v0.4.0-cf1.0.0`, then `v0.4.0-cf1.0.1` for a
small follow-up, `v0.4.0-cf1.1.0` for a round of new fixes, `v0.4.0-cf2.0.0`
for a larger step, and back to `v0.4.1-cf1.0.0` once upstream ships 0.4.1 and
it is merged. All three parts are required; `a` goes up to 99 and `b` and `c`
up to 9. The app reports the same string, `0.4.0-cf1.0.0`, in Settings and in
its CTCP VERSION reply. Pushing the tag runs
[`publish-community.yaml`](../.github/workflows/publish-community.yaml), which
builds and attaches to a GitHub release:

- Linux: `.deb`, `.rpm` and AppImage for x64 and arm64
- Windows: `.msi` and `.exe` installers
- macOS: `.dmg` for Apple silicon and Intel, unsigned (right-click, Open)
- Android: signed `.apk`
- Web: `Obby-<version>-web.zip` with the built `dist/`
- Docker: `ghcr.io/<owner>/obby:<version>-cf<a>.<b>.<c>` and `:latest` for
  amd64 and arm64

Upstream's `publish.yaml` is left as is, so merges from upstream stay clean.
The tag also matches its `v*.*.*` trigger, so that workflow has to stay
disabled on this repository (see below). iOS and Google Play are not built:
both need accounts the fork does not have.

## Cutting a release

1. `version` in `package.json` stays upstream's; it changes only when a new
   upstream version is merged. Pick the next `cf` number for it.
2. Fast-forward the release branch and tag it:

   ```sh
   git fetch origin
   git checkout community-fixes-release
   git merge --ff-only origin/community-fixes
   git tag v0.4.0-cf1.0.0
   git push origin community-fixes-release v0.4.0-cf1.0.0
   ```

3. Watch the run under Actions. The release appears on the Releases page as
   a draft named `Obby 0.4.0-cf1.0.0` with generated notes since the previous
   community release. Publish it from there when it is ready for others.

If the tag is not `v` plus the `package.json` version plus `-cf<a>.<b>.<c>`,
the run stops in its first job before building anything. The Android version
code is `major * 100000000 + minor * 1000000 + patch * 10000 + a * 100 + b * 10 + c`,
so it rises with every release and every upstream bump as long as the parts
stay within their limits.

## One-time setup

- Actions must be enabled for the repository (forks start with them off), and
  upstream's "Tauri Build and Publish" workflow disabled from its menu in the
  Actions tab: it would otherwise run on every sync of `main` and on every
  community tag.
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
