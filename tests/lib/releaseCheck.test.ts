import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareReleases,
  fetchLatestRelease,
  isNewerRelease,
  newerRelease,
  parseReleaseVersion,
  pickApkAsset,
  RELEASE_CHECK_INTERVAL_MS,
  ReleaseCheckFailed,
  shortReleaseLabel,
} from "../../src/lib/releaseCheck";

const release = (tag: string) =>
  ({
    ok: true,
    json: async () => ({
      tag_name: tag,
      html_url: `https://example.test/releases/${tag}`,
      body: "notes",
      assets: [],
    }),
  }) as unknown as Response;
const fetching = (answer: () => Promise<Response>) =>
  vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => answer());

describe("release versions", () => {
  it("reads community versions and orders them", () => {
    expect(parseReleaseVersion("v0.4.0-cf1.0.1")).toEqual({
      upstream: [0, 4, 0],
      community: [1, 0, 1],
    });
    expect(parseReleaseVersion("0.4.0")).toBeNull();
    expect(parseReleaseVersion("v0.4.0-cf1")).toBeNull();
    const v = (t: string) => parseReleaseVersion(t) as never;
    expect(compareReleases(v("0.4.0-cf1.0.1"), v("0.4.0-cf1.0.0"))).toBe(1);
    expect(compareReleases(v("0.5.0-cf1.0.0"), v("0.4.0-cf9.9.9"))).toBe(1);
    expect(compareReleases(v("0.4.0-cf1.0.1"), v("0.4.0-cf1.0.1"))).toBe(0);
  });

  it("calls a release newer only when it is one", () => {
    expect(isNewerRelease("0.4.0-cf1.0.2", "0.4.0-cf1.0.1")).toBe(true);
    expect(isNewerRelease("0.4.0-cf1.0.1", "0.4.0-cf1.0.1")).toBe(false);
    expect(isNewerRelease("v0.4.1", "0.4.0-cf1.0.1")).toBe(false);
  });
});

const SHA = "f68a".repeat(16);
const asset = (
  name: string,
  digest: unknown = `sha256:${SHA.toUpperCase()}`,
) => ({
  name,
  size: 83105584,
  digest,
  browser_download_url: `https://github.com/o/r/releases/download/v0.4.0-cf1.2.1/${name}`,
});

describe("pickApkAsset", () => {
  it("picks the APK named for the version when there are several", () => {
    const picked = pickApkAsset(
      [asset("Obby-0.4.0-cf1.2.1.apk"), asset("Obby-debug.apk")],
      "0.4.0-cf1.2.1",
    );
    expect(picked?.name).toBe("Obby-0.4.0-cf1.2.1.apk");
    expect(picked?.sha256).toBe(SHA);
    expect(
      pickApkAsset(
        [asset("Obby-debug.apk"), asset("Obby-0.4.0-cf1.2.1.apk")],
        "0.4.0-cf1.2.1",
      )?.name,
    ).toBe("Obby-0.4.0-cf1.2.1.apk");
    expect(pickApkAsset([asset("other.apk")], "0.4.0-cf1.2.1")?.name).toBe(
      "other.apk",
    );
  });

  it("takes the exact file over another version that contains this one", () => {
    const named = "Obby-0.4.0-cf1.2.1.apk";
    for (const other of [
      "Obby-0.4.0-cf1.2.10.apk",
      "Obby-0.4.0-cf1.2.1-debug.apk",
    ]) {
      expect(
        pickApkAsset([asset(other), asset(named)], "0.4.0-cf1.2.1")?.name,
      ).toBe(named);
    }
  });

  it("gives nothing without an APK or a SHA-256 digest", () => {
    expect(pickApkAsset([], "1")).toBeNull();
    expect(pickApkAsset(undefined, "1")).toBeNull();
    expect(pickApkAsset([asset("notes.txt")], "1")).toBeNull();
    expect(pickApkAsset([asset("a.apk", null)], "1")).toBeNull();
    expect(pickApkAsset([asset("a.apk", "sha1:abc")], "1")).toBeNull();
  });
});

describe("shortReleaseLabel", () => {
  it("keeps the community part of a version", () => {
    expect(shortReleaseLabel("0.4.0-cf1.2.1")).toBe("cf1.2.1");
    expect(shortReleaseLabel("0.4.0")).toBe("0.4.0");
  });
});

describe("fetchLatestRelease", () => {
  it("reads the notes and the APK asset", async () => {
    const fetchImpl = fetching(
      async () =>
        ({
          ok: true,
          json: async () => ({
            tag_name: "v0.4.0-cf1.2.1",
            html_url: "https://example.test/r",
            body: "## What's Changed",
            assets: [asset("Obby-0.4.0-cf1.2.1.apk")],
          }),
        }) as unknown as Response,
    );
    const latest = await fetchLatestRelease("o/r", fetchImpl);
    expect(latest?.notes).toBe("## What's Changed");
    expect(latest?.apk).toEqual({
      name: "Obby-0.4.0-cf1.2.1.apk",
      size: 83105584,
      sha256: SHA,
      url: "https://github.com/o/r/releases/download/v0.4.0-cf1.2.1/Obby-0.4.0-cf1.2.1.apk",
    });
  });

  it("returns the tag without its v and the page", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    await expect(
      fetchLatestRelease("khamere/obby", fetchImpl, "https://api.github.com"),
    ).resolves.toEqual({
      version: "0.4.0-cf1.0.2",
      url: "https://example.test/releases/v0.4.0-cf1.0.2",
      notes: "notes",
      apk: null,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/khamere/obby/releases/latest",
    );
  });

  it("answers null when the repository has no published release", async () => {
    const notFound = { ok: false, status: 404 } as Response;
    await expect(
      fetchLatestRelease(
        "x/y",
        fetching(async () => notFound),
      ),
    ).resolves.toBeNull();
  });

  it("fails when the request brings no answer", async () => {
    const limited = { ok: false, status: 403 } as Response;
    await expect(
      fetchLatestRelease(
        "x/y",
        fetching(async () => limited),
      ),
    ).rejects.toBeInstanceOf(ReleaseCheckFailed);
    await expect(
      fetchLatestRelease(
        "x/y",
        fetching(async () => {
          throw new TypeError("offline");
        }),
      ),
    ).rejects.toBeInstanceOf(ReleaseCheckFailed);
    await expect(
      fetchLatestRelease(
        "x/y",
        fetching(
          async () =>
            ({ ok: true, json: async () => ({}) }) as unknown as Response,
        ),
      ),
    ).rejects.toBeInstanceOf(ReleaseCheckFailed);
  });
});

describe("newerRelease", () => {
  let backing: Map<string, string>;
  beforeEach(() => {
    backing = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks once a day and reports only a newer release", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    const args = { repo: "khamere/obby", current: "0.4.0-cf1.0.1", fetchImpl };
    await expect(newerRelease({ ...args, now: 1000 })).resolves.toMatchObject({
      version: "0.4.0-cf1.0.2",
    });
    await expect(newerRelease({ ...args, now: 2000 })).resolves.toMatchObject({
      version: "0.4.0-cf1.0.2",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await newerRelease({ ...args, now: 1000 + RELEASE_CHECK_INTERVAL_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      newerRelease({ ...args, current: "0.4.0-cf1.0.2", now: 3000 }),
    ).resolves.toBeNull();
  });

  it("asks again when the build comes from another repository", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    await newerRelease({
      repo: "a/obby",
      current: "0.4.0-cf1.0.1",
      fetchImpl,
      now: 1,
    });
    await newerRelease({
      repo: "b/obby",
      current: "0.4.0-cf1.0.1",
      fetchImpl,
      now: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("asks again when the build asks another API", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    const args = { repo: "o/r", current: "0.4.0-cf1.0.1", fetchImpl };
    await newerRelease({ ...args, api: "https://a.example", now: 1 });
    await newerRelease({ ...args, api: "https://b.example", now: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "https://b.example/repos/o/r/releases/latest",
    );
    await newerRelease({ ...args, api: "https://b.example", now: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("asks again when the cache comes from an older build", async () => {
    backing.set(
      "obby.releaseCheck",
      JSON.stringify({
        repo: "o/r",
        checkedAt: 1,
        latest: { version: "0.4.0-cf1.0.2", url: "https://example.test" },
      }),
    );
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    await newerRelease({
      repo: "o/r",
      current: "0.4.0-cf1.0.1",
      fetchImpl,
      now: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("asks again when forced", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    const args = { repo: "o/r", current: "0.4.0-cf1.0.1", fetchImpl };
    await newerRelease({ ...args, now: 1 });
    await newerRelease({ ...args, now: 2, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a failed request is not remembered and keeps the last answer", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    const args = { repo: "o/r", current: "0.4.0-cf1.0.1", fetchImpl };
    await newerRelease({ ...args, now: 1 });
    fetchImpl.mockRejectedValueOnce(new TypeError("offline"));
    await expect(
      newerRelease({ ...args, now: 2, force: true }),
    ).rejects.toBeInstanceOf(ReleaseCheckFailed);
    await expect(newerRelease({ ...args, now: 3 })).resolves.toMatchObject({
      version: "0.4.0-cf1.0.2",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("asks again after a failed first request", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    const args = { repo: "o/r", current: "0.4.0-cf1.0.1", fetchImpl };
    fetchImpl.mockRejectedValueOnce(new TypeError("offline"));
    await expect(newerRelease({ ...args, now: 1 })).rejects.toBeInstanceOf(
      ReleaseCheckFailed,
    );
    await expect(newerRelease({ ...args, now: 2 })).resolves.toMatchObject({
      version: "0.4.0-cf1.0.2",
    });
  });

  it("asks the configured API", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    await newerRelease({
      repo: "o/r",
      api: "https://test.example",
      current: "0.4.0-cf1.0.1",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://test.example/repos/o/r/releases/latest",
    );
  });

  it("does nothing for a build without a release repository or label", async () => {
    const fetchImpl = fetching(async () => release("v9.0.0-cf1.0.0"));
    await expect(
      newerRelease({ repo: "", current: "0.4.0-cf1.0.1", fetchImpl }),
    ).resolves.toBeNull();
    await expect(
      newerRelease({ repo: "x/y", current: "0.4.0", fetchImpl }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
