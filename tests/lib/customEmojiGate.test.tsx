import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEmojiPackCache,
  useEmojiResolver,
} from "../../src/lib/customEmoji";
import useStore from "../../src/store";

const PACK = "https://packs.example/pack.json";
const pack = {
  id: "p",
  name: "Pack",
  emoji: {
    ok: { url: "https://files.example/ok.png" },
    beacon: { url: "https://attacker.example/beacon.png" },
  },
};

// A channel op or the server names the pack URL, so the user's media
// visibility rule decides whether anything is fetched from it at all.
const HOSTS = ["https://packs.example", "https://files.example"];
const NO_MEDIA = 0;
const SAFE_MEDIA = 1;

describe("useEmojiResolver media gate", () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => pack,
  }));
  beforeEach(() => {
    clearEmojiPackCache();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("never fetches a pack the rule rejects", async () => {
    const { result } = renderHook(() =>
      useEmojiResolver([PACK], HOSTS, NO_MEDIA),
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.resolve("ok")).toBeNull();
    expect(result.current.shortcodes).toEqual([]);
  });

  it("fetches an allowed pack but hides emoji hosted elsewhere", async () => {
    const { result } = renderHook(() =>
      useEmojiResolver([PACK], HOSTS, SAFE_MEDIA),
    );
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.resolve("ok")?.url).toBe(
      "https://files.example/ok.png",
    );
    expect(result.current.resolve("beacon")).toBeNull();
    expect(result.current.shortcodes.map((e) => e.shortcode)).toEqual(["ok"]);
  });

  it("never fetches a pack from a site the user only allowed for media", async () => {
    useStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        mediaVisibilityLevel: 1,
        mediaAllowedHosts: ["packs.example", "files.example"],
      },
    }));
    const { result } = renderHook(() =>
      useEmojiResolver([PACK], [], SAFE_MEDIA),
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.resolve("ok")).toBeNull();
  });
});
