import { APP_VERSION } from "./appVersion";

// Community builds carry no updater of their own; they learn about a newer
// release by asking the repository they were built from, once a day, and
// only when the build was told where that is.
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The v2 key keeps an entry written before notes and assets existed from
// being read as a complete answer: it is simply ignored, so we ask again.
const STORAGE_KEY = "obby.releaseCheck.v2";
const REQUEST_TIMEOUT_MS = 10_000;

export interface ReleaseVersion {
  upstream: [number, number, number];
  community: [number, number, number];
}

export const RELEASES_API: string = __APP_RELEASES_API__;

export interface ApkAsset {
  name: string;
  size: number;
  /** Lowercase hex, without the "sha256:" prefix. */
  sha256: string;
  url: string;
}

export interface LatestRelease {
  version: string;
  url: string;
  notes: string;
  apk: ApkAsset | null;
}

/**
 * The APK to install: the one named for the version when a release carries
 * several, by its exact name first, since "cf1.2.1" is also the start of
 * "cf1.2.10". An asset without a SHA-256 digest is useless to us, since
 * nothing may install unverified.
 */
export function pickApkAsset(
  assets: unknown,
  version: string,
): ApkAsset | null {
  if (!Array.isArray(assets)) return null;
  const found: ApkAsset[] = [];
  for (const entry of assets) {
    if (!entry || typeof entry !== "object") continue;
    const { name, size, digest, browser_download_url } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof name !== "string" ||
      !name.toLowerCase().endsWith(".apk") ||
      typeof size !== "number" ||
      typeof browser_download_url !== "string" ||
      typeof digest !== "string"
    )
      continue;
    const match = /^sha256:([0-9a-f]{64})$/i.exec(digest);
    if (!match) continue;
    found.push({
      name,
      size,
      sha256: match[1].toLowerCase(),
      url: browser_download_url,
    });
  }
  const exact = `obby-${version}.apk`.toLowerCase();
  return (
    found.find((a) => a.name.toLowerCase() === exact) ??
    found.find((a) => a.name.includes(version)) ??
    found[0] ??
    null
  );
}

/** "0.4.0-cf1.2.1" becomes "cf1.2.1"; anything else is shown as it is. */
export function shortReleaseLabel(version: string): string {
  return /^\d+\.\d+\.\d+-(cf\d+\.\d+\.\d+)$/.exec(version)?.[1] ?? version;
}

interface Remembered {
  repo: string;
  api: string;
  checkedAt: number;
  latest: LatestRelease | null;
}

/** Reads "0.4.0-cf1.0.1" or "v0.4.0-cf1.0.1"; anything else is no community version. */
export function parseReleaseVersion(text: string): ReleaseVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)-cf(\d+)\.(\d+)\.(\d+)$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const [, a, b, c, d, e, f] = match.map(Number);
  return { upstream: [a, b, c], community: [d, e, f] };
}

export function compareReleases(a: ReleaseVersion, b: ReleaseVersion): number {
  const parts = [...a.upstream, ...a.community];
  const others = [...b.upstream, ...b.community];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== others[i]) return parts[i] - others[i];
  }
  return 0;
}

export function isNewerRelease(
  candidate: string,
  current: string = APP_VERSION,
): boolean {
  const next = parseReleaseVersion(candidate);
  const now = parseReleaseVersion(current);
  return !!next && !!now && compareReleases(next, now) > 0;
}

/** The request brought no usable answer, which says nothing about releases. */
export class ReleaseCheckFailed extends Error {}

/** The newest release, or null when the repository has published none. */
export async function fetchLatestRelease(
  repo: string,
  fetchImpl: typeof fetch = fetch,
  api: string = RELEASES_API,
): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${api}/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ReleaseCheckFailed(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
      body?: unknown;
      assets?: unknown;
    };
    if (typeof body.tag_name !== "string" || typeof body.html_url !== "string")
      throw new ReleaseCheckFailed("unreadable answer");
    const version = body.tag_name.replace(/^v/, "");
    return {
      version,
      url: body.html_url,
      notes: typeof body.body === "string" ? body.body : "",
      apk: pickApkAsset(body.assets, version),
    };
  } catch (e) {
    if (e instanceof ReleaseCheckFailed) throw e;
    throw new ReleaseCheckFailed(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

function remembered(): Remembered | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Remembered) : null;
  } catch {
    return null;
  }
}

function remember(entry: Remembered): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // storage disabled: we ask again next time
  }
}

/**
 * The newer release, if the repository has one, asked at most once a day.
 * Throws ReleaseCheckFailed when the repository could not be asked.
 */
export async function newerRelease({
  repo = __APP_RELEASES_REPO__,
  api = RELEASES_API,
  current = APP_VERSION,
  now = Date.now(),
  fetchImpl = fetch,
  force = false,
}: {
  repo?: string;
  api?: string;
  current?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  /** Skips the daily cache, for a person who asked to check now. */
  force?: boolean;
} = {}): Promise<LatestRelease | null> {
  if (!repo || !parseReleaseVersion(current)) return null;
  const known = remembered();
  let latest: LatestRelease | null;
  // The answer is kept a day, for the repository and the API it came from:
  // a build that asks elsewhere and is served on the same origin asks afresh.
  if (
    !force &&
    known &&
    known.repo === repo &&
    known.api === api &&
    now - known.checkedAt < RELEASE_CHECK_INTERVAL_MS
  ) {
    latest = known.latest;
  } else {
    // A request that fails throws here, before anything is remembered, so
    // only a real answer is kept for the day.
    latest = await fetchLatestRelease(repo, fetchImpl, api);
    remember({ repo, api, checkedAt: now, latest });
  }
  return latest && isNewerRelease(latest.version, current) ? latest : null;
}
