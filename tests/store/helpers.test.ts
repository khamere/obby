import { describe, expect, it } from "vitest";
import { resolveUserMetadata, withReaction } from "../../src/store/helpers";
import type { Channel, Message } from "../../src/types";

function makeChannel(
  name: string,
  users: {
    username: string;
    metadata?: Record<
      string,
      { value: string | undefined; visibility: string }
    >;
  }[] = [],
): Channel {
  return {
    id: `ch-${name}`,
    name,
    isPrivate: false,
    serverId: "srv-1",
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users: users.map((u) => ({ id: `${u.username}-id`, isOnline: true, ...u })),
  };
}

const AVATAR = {
  value: "http://cdn.example.com/avatar.png",
  visibility: "public",
};
const META = { avatar: AVATAR };

describe("resolveUserMetadata", () => {
  it("returns localStorage metadata when present", () => {
    const serverMeta = { bob: META };
    const result = resolveUserMetadata("bob", serverMeta, []);
    expect(result).toEqual(META);
  });

  it("falls back to cross-channel metadata when localStorage has no entry", () => {
    const channels = [
      makeChannel("#other", [{ username: "bob", metadata: META }]),
    ];
    const result = resolveUserMetadata("bob", undefined, channels);
    expect(result).toEqual(META);
  });

  it("skips excludeChannelName in cross-channel search", () => {
    const channels = [
      makeChannel("#target", [{ username: "bob", metadata: META }]),
      makeChannel("#other", [{ username: "bob" }]),
    ];
    // Only #target has metadata for bob but it's excluded
    const result = resolveUserMetadata("bob", undefined, channels, "#target");
    expect(result).toEqual({});
  });

  it("returns {} when neither localStorage nor cross-channel has metadata", () => {
    const channels = [makeChannel("#general", [{ username: "bob" }])];
    const result = resolveUserMetadata("bob", {}, channels);
    expect(result).toEqual({});
  });

  it("cross-channel lookup is case-insensitive on username", () => {
    const channels = [
      makeChannel("#general", [{ username: "Bob", metadata: META }]),
    ];
    const result = resolveUserMetadata("bob", undefined, channels);
    expect(result).toEqual(META);
  });

  it("prefers localStorage over cross-channel", () => {
    const localMeta = {
      avatar: { value: "http://local.example.com/a.png", visibility: "public" },
    };
    const channelMeta = {
      avatar: {
        value: "http://channel.example.com/a.png",
        visibility: "public",
      },
    };
    const channels = [
      makeChannel("#general", [{ username: "bob", metadata: channelMeta }]),
    ];
    const result = resolveUserMetadata("bob", { bob: localMeta }, channels);
    expect(result).toEqual(localMeta);
  });
});

describe("withReaction", () => {
  const message = { reactions: [] } as unknown as Message;

  it.each([
    "👍",
    "👨‍👩‍👧‍👦",
    "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    ":custom_emoji:",
    "+1",
    "constructor",
    "well done",
    "two  spaces",
    "x PRIVMSG #chan :text",
  ])("keeps %s", (value) => {
    expect(withReaction(message, value, "alice")?.reactions).toEqual([
      { emoji: value, userId: "alice" },
    ]);
  });

  it.each([
    ["a leading space", " x"],
    ["a trailing space", "x "],
    ["only spaces", "  "],
    ["a line separator", "x\u2028y"],
    ["a line break", "x\r\nQUIT"],
    ["a tab", "x\ty"],
    ["a control character", "x\u0000y"],
    ["a no-break space", "x\u00a0y"],
    ["more text than a reaction holds", "x".repeat(65)],
    ["nothing", ""],
  ])("drops a reaction with %s", (_, value) => {
    expect(withReaction(message, value, "alice")).toBeNull();
  });
});
