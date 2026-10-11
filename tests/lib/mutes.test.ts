import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatMute,
  isServerMuted,
  isSilenced,
  muteChat,
  muteServer,
  resetMutesForTests,
  unmuteChat,
  unmuteServer,
} from "../../src/lib/mutes";
import { shouldPlayNotificationSound } from "../../src/lib/notificationSounds";

const HOUR = 60 * 60 * 1000;

describe("mutes", () => {
  let backing: Map<string, string>;

  beforeEach(() => {
    resetMutesForTests();
    backing = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("a muted server silences everything in it, mentions included", () => {
    muteServer("s1", null);
    expect(isSilenced("s1", "chan", true)).toBe(true);
    expect(isSilenced("s1", "dm", false)).toBe(true);
    expect(isSilenced("s2", "chan", false)).toBe(false);
  });

  it("a muted channel still lets mentions through", () => {
    muteChat("s1", "chan", "channel", null);
    expect(isSilenced("s1", "chan", false)).toBe(true);
    expect(isSilenced("s1", "chan", true)).toBe(false);
    expect(isSilenced("s1", "other", false)).toBe(false);
  });

  it("a muted DM is fully silent", () => {
    muteChat("s1", "dm", "dm", null);
    expect(isSilenced("s1", "dm", true)).toBe(true);
  });

  it("timed mutes expire", () => {
    const now = Date.now();
    muteServer("s1", now + HOUR);
    muteChat("s1", "chan", "channel", now + 8 * HOUR);
    expect(isServerMuted("s1", now + HOUR - 1)).toBe(true);
    expect(isServerMuted("s1", now + HOUR + 1)).toBe(false);
    expect(chatMute("s1", "chan", now + 9 * HOUR)).toBeUndefined();
  });

  it("unmuting works and mutes survive a reload", () => {
    muteServer("s1", null);
    muteChat("s1", "chan", "channel", null);
    resetMutesForTests(); // reload: state comes back from storage
    expect(isServerMuted("s1")).toBe(true);
    expect(chatMute("s1", "chan")).toBeDefined();
    unmuteServer("s1");
    unmuteChat("s1", "chan");
    expect(isSilenced("s1", "chan", false)).toBe(false);
  });

  it("the notification sound respects mutes", () => {
    const settings = {
      enableHighlights: true,
      enableNotificationSounds: true,
      notificationVolume: 0.5,
      customMentions: [],
    };
    const me = { username: "me" };
    const msg = (channelId: string, content: string) => ({
      type: "message",
      userId: "bob",
      serverId: "s1",
      channelId,
      content,
    });
    expect(
      shouldPlayNotificationSound(msg("chan", "hi me"), me, settings),
    ).toBe(true);
    muteChat("s1", "chan", "channel", null);
    expect(
      shouldPlayNotificationSound(msg("chan", "hi all"), me, settings),
    ).toBe(false);
    // a mention in a muted channel still sounds
    expect(
      shouldPlayNotificationSound(msg("chan", "hi me"), me, settings),
    ).toBe(true);
    muteServer("s1", null);
    expect(
      shouldPlayNotificationSound(msg("chan", "hi me"), me, settings),
    ).toBe(false);
  });
});
