import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareReleases,
  fetchLatestRelease,
  isNewerRelease,
  newerRelease,
  parseReleaseVersion,
  RELEASE_CHECK_INTERVAL_MS,
} from "../../src/lib/releaseCheck";

const release = (tag: string) =>
  ({
    ok: true,
    json: async () => ({
      tag_name: tag,
      html_url: `https://example.test/releases/${tag}`,
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

describe("fetchLatestRelease", () => {
  it("returns the tag without its v and the page", async () => {
    const fetchImpl = fetching(async () => release("v0.4.0-cf1.0.2"));
    await expect(
      fetchLatestRelease("khamere/obby", fetchImpl),
    ).resolves.toEqual({
      version: "0.4.0-cf1.0.2",
      url: "https://example.test/releases/v0.4.0-cf1.0.2",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/khamere/obby/releases/latest",
    );
  });

  it("answers null when there is no published release or the request fails", async () => {
    const notFound = { ok: false } as Response;
    await expect(
      fetchLatestRelease(
        "x/y",
        fetching(async () => notFound),
      ),
    ).resolves.toBeNull();
    await expect(
      fetchLatestRelease(
        "x/y",
        fetching(async () => {
          throw new TypeError("offline");
        }),
      ),
    ).resolves.toBeNull();
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
