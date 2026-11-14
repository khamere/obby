import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEmojiPackCache,
  useEmojiResolver,
} from "../../src/lib/customEmoji";

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
// Callers keep the rule's identity stable, as these do.
const deny = () => false;
const allowOwnHost = (url: string) =>
  !url.startsWith("https://attacker.example/");

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
    const { result } = renderHook(() => useEmojiResolver([PACK], deny));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.resolve("ok")).toBeNull();
    expect(result.current.shortcodes).toEqual([]);
  });

  it("fetches an allowed pack but hides emoji hosted elsewhere", async () => {
    const { result } = renderHook(() => useEmojiResolver([PACK], allowOwnHost));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.resolve("ok")?.url).toBe(
      "https://files.example/ok.png",
    );
    expect(result.current.resolve("beacon")).toBeNull();
    expect(result.current.shortcodes.map((e) => e.shortcode)).toEqual(["ok"]);
  });
});
