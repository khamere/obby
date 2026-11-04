import { APP_VERSION } from "./appVersion";

// Community builds carry no updater of their own; they learn about a newer
// release by asking the repository they were built from, once a day, and
// only when the build was told where that is.
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "obby.releaseCheck";
const REQUEST_TIMEOUT_MS = 10_000;

export interface ReleaseVersion {
  upstream: [number, number, number];
  community: [number, number, number];
}

export interface LatestRelease {
  version: string;
  url: string;
}

interface Remembered {
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

export async function fetchLatestRelease(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    if (typeof body.tag_name !== "string" || typeof body.html_url !== "string")
      return null;
    return { version: body.tag_name.replace(/^v/, ""), url: body.html_url };
  } catch {
    return null;
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

/** The newer release, if the repository has one, asked at most once a day. */
export async function newerRelease({
  repo = __APP_RELEASES_REPO__,
  current = APP_VERSION,
  now = Date.now(),
  fetchImpl = fetch,
}: {
  repo?: string;
  current?: string;
  now?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<LatestRelease | null> {
  if (!repo || !parseReleaseVersion(current)) return null;
  const known = remembered();
  let latest: LatestRelease | null;
  if (known && now - known.checkedAt < RELEASE_CHECK_INTERVAL_MS) {
    latest = known.latest;
  } else {
    latest = await fetchLatestRelease(repo, fetchImpl);
    remember({ checkedAt: now, latest });
  }
  return latest && isNewerRelease(latest.version, current) ? latest : null;
}
