import { describe, expect, it } from "vitest";
import {
  capMergedMessages,
  dialsSavedAddress,
  MAX_MESSAGES_PER_CHANNEL,
  mergeHistoryPage,
  resolveUserMetadata,
  withoutReaction,
  withReaction,
} from "../../src/store/helpers";
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
    "bien\u00a0vu",
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
    ["a paragraph separator", "x\u2029y"],
    ["more text than a reaction holds", "x".repeat(65)],
    ["nothing", ""],
  ])("drops a reaction with %s", (_, value) => {
    expect(withReaction(message, value, "alice")).toBeNull();
  });
});

// A nick is the same nick in any case, and it can change case while a reaction
// made under the earlier spelling is still on the message.
describe("a reaction made before a nick changed case", () => {
  const message = {
    reactions: [{ emoji: "👍", userId: "Alice" }],
  } as unknown as Message;

  it("is not added a second time", () => {
    expect(withReaction(message, "👍", "alice")).toBeNull();
  });

  it("is removed", () => {
    expect(withoutReaction(message, "👍", "alice")?.reactions).toEqual([]);
  });

  it("leaves another nick's reaction alone", () => {
    expect(withoutReaction(message, "👍", "alicia")).toBeNull();
  });
});

describe("a connection dialling the address a login is saved for", () => {
  const saved = { host: "wss://bouncer.example/socket", port: 443 };

  it("matches the same address and port", () => {
    expect(dialsSavedAddress({ ...saved }, saved)).toBe(true);
  });

  it("reads a bare host with its port as a secure websocket address", () => {
    expect(
      dialsSavedAddress(
        { host: "wss://bouncer.example:6697", port: 6697 },
        { host: "bouncer.example", port: 6697 },
      ),
    ).toBe(true);
  });

  it("tells another host, another port and no connection apart", () => {
    expect(
      dialsSavedAddress({ host: "wss://old.example/socket", port: 443 }, saved),
    ).toBe(false);
    expect(dialsSavedAddress({ ...saved, port: 8443 }, saved)).toBe(false);
    expect(dialsSavedAddress(undefined, saved)).toBe(false);
  });
});

describe("mergeHistoryPage", () => {
  const said = (msgid: string, time: number): Message =>
    ({
      id: `id-${msgid}`,
      msgid,
      content: msgid,
      userId: "alice",
      timestamp: new Date(time),
    }) as Message;
  const order = (existing: Message[], page: Message[]) =>
    mergeHistoryPage(existing, page).merged.map((m) => m.msgid);

  it("puts an older page ahead of the lines we hold in the millisecond it ends in", () => {
    const existing = [said("m3", 1000), said("m4", 1000), said("m5", 2000)];
    const page = [said("m0", 500), said("m1", 1000), said("m2", 1000)];

    expect(order(existing, page)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("puts a newer page behind the lines we hold in the millisecond it starts in", () => {
    const existing = [said("m0", 500), said("m1", 1000)];
    const page = [said("m2", 1000), said("m3", 1000), said("m4", 2000)];

    expect(order(existing, page)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("fits a page between the lines we hold on both sides of it", () => {
    const existing = [said("m0", 1000), said("m5", 2000), said("m6", 2000)];
    const page = [
      said("m1", 1000),
      said("m2", 1500),
      said("m3", 2000),
      said("m4", 2000),
    ];

    expect(order(existing, page)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
  });

  it("keeps the page's order around a line we already hold, and adds it once", () => {
    const held = said("m2", 1000);
    const existing = [said("m0", 500), held];
    const page = [said("m1", 1000), said("m2", 1000), said("m3", 1000)];

    const { merged, added } = mergeHistoryPage(existing, page);

    expect(merged.map((m) => m.msgid)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(merged[2]).toBe(held);
    expect(added.map((m) => m.msgid)).toEqual(["m1", "m3"]);
  });

  it("puts a page of one millisecond ahead of our lines there when we hold nothing older", () => {
    const existing = [said("m2", 1000), said("m3", 2000)];
    const page = [said("m0", 1000), said("m1", 1000)];

    expect(order(existing, page)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  it("puts a page of one millisecond ahead of our lines there when all we hold from before is a join", () => {
    const joined = { ...said("j0", 400), type: "join" } as Message;
    const existing = [joined, said("m1", 1000), said("m2", 1000)];
    const page = [said("m0", 1000)];

    expect(order(existing, page)).toEqual(["j0", "m0", "m1", "m2"]);
  });

  it("keeps two alike lines apart when the server gave them different ids", () => {
    const twin = (msgid: string): Message => ({
      ...said(msgid, 1000),
      content: "ok",
    });
    const existing = [twin("m1")];

    const { merged, added } = mergeHistoryPage(existing, [
      twin("m1"),
      twin("m2"),
    ]);

    expect(merged.map((m) => m.msgid)).toEqual(["m1", "m2"]);
    expect(added.map((m) => m.msgid)).toEqual(["m2"]);
  });

  it("takes a line without an id for the alike line we hold", () => {
    const existing = [{ ...said("m1", 1000), content: "ok" }];
    const echo = { ...said("m1", 1000), content: "ok", msgid: undefined };

    const { merged, added } = mergeHistoryPage(existing, [echo as Message]);

    expect(merged).toEqual(existing);
    expect(added).toEqual([]);
  });

  it("takes a line with an id for the alike line we hold without one", () => {
    const local = { ...said("m1", 1000), content: "ok", msgid: undefined };
    const existing = [local as Message];

    const { merged, added } = mergeHistoryPage(existing, [
      { ...said("m1", 1000), content: "ok" },
    ]);

    expect(merged).toEqual(existing);
    expect(added).toEqual([]);
  });

  it("gives the lines a page names its order when the page brings nothing new", () => {
    const existing = [said("m2", 1000), said("j", 1000), said("m1", 1000)];
    const page = [said("m1", 1000), said("m2", 1000)];

    expect(order(existing, page)).toEqual(["m1", "j", "m2"]);
  });

  it("leaves a line we hold where it is when a page that leaves it out brings nothing new", () => {
    const existing = [said("m1", 1000), said("m2", 1000), said("m3", 1000)];
    const page = [said("m1", 1000), said("m3", 1000)];

    expect(order(existing, page)).toEqual(["m1", "m2", "m3"]);
  });

  it("returns what we hold, in order, for an empty page", () => {
    const existing = [said("m1", 2000), said("m0", 1000)];

    expect(order(existing, [])).toEqual(["m0", "m1"]);
  });

  it("puts a newest page of one millisecond behind the only line we hold there", () => {
    const existing = [said("m1", 1000)];
    const page = [said("m2", 1000), said("m3", 1000), said("m4", 1000)];

    expect(
      mergeHistoryPage(existing, page, "newest").merged.map((m) => m.msgid),
    ).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("puts rows read from the newer side behind our lines when all of them share one millisecond", () => {
    const existing = [said("m1", 1000), said("m2", 1000)];
    const page = [said("m3", 1000), said("m4", 1000)];

    expect(
      mergeHistoryPage(existing, page, "newest").merged.map((m) => m.msgid),
    ).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("puts a page of one millisecond right ahead of the line it was asked from, between the lines we hold there", () => {
    const existing = [
      said("m0", 500),
      said("m1", 1000),
      said("m4", 1000),
      said("m5", 1000),
      said("m6", 2000),
    ];
    const page = [said("m2", 1000), said("m3", 1000)];

    expect(
      mergeHistoryPage(existing, page, { before: "m4" }).merged.map(
        (m) => m.msgid,
      ),
    ).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("keeps our lines ahead of a page of one millisecond that repeats the lines behind them", () => {
    const existing = ["m0", "m1", "m2", "m3"].map((msgid) => said(msgid, 1000));
    const page = [said("m2", 1000), said("m3", 1000), said("m4", 1000)];

    expect(order(existing, page)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("keeps a line that reached us after a newest page of one millisecond behind that page", () => {
    const existing = [said("m1", 1000), said("m2", 1000)];
    const page = [said("m0", 1000), said("m1", 1000)];

    expect(
      mergeHistoryPage(existing, page, "newest").merged.map((m) => m.msgid),
    ).toEqual(["m0", "m1", "m2"]);
  });

  it("places a page by its times when we do not hold the line it was asked from", () => {
    const existing = [said("m3", 1000), said("m4", 2000)];
    const page = [said("m0", 500), said("m1", 1000), said("m2", 1000)];

    expect(
      mergeHistoryPage(existing, page, { before: "gone" }).merged.map(
        (m) => m.msgid,
      ),
    ).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});

describe("capMergedMessages", () => {
  const said = (index: number, time: number): Message =>
    ({
      id: `id-${index}`,
      msgid: `m${index}`,
      content: `line ${index}`,
      userId: "alice",
      timestamp: new Date(time),
    }) as Message;
  const full = Array.from({ length: MAX_MESSAGES_PER_CHANNEL }, (_, index) =>
    said(index + 1, 1000 + Math.floor(index / 10)),
  );

  it("keeps an older line that shares the millisecond of the oldest line we hold at the cap", () => {
    const older = said(0, 1000);

    const capped = capMergedMessages(full, [older, ...full], undefined);

    expect(capped.messages).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(capped.messages[0]).toBe(older);
    expect(capped.window?.present).toBe(full);
  });

  it("keeps the newest end when the newest page puts a line first at the cap", () => {
    const first = said(0, 1000);
    const live = said(MAX_MESSAGES_PER_CHANNEL + 1, 9000);
    const merged = [first, ...full, live];

    const capped = capMergedMessages(full, merged, undefined, "newest");

    expect(capped.messages).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(capped.messages.at(-1)).toBe(live);
    expect(capped.window).toBeUndefined();
  });

  it("drops the oldest end when a newer line arrives at the cap", () => {
    const newer = said(MAX_MESSAGES_PER_CHANNEL + 1, 9000);

    const capped = capMergedMessages(full, [...full, newer], undefined);

    expect(capped.messages.at(-1)).toBe(newer);
    expect(capped.messages[0]).toBe(full[1]);
    expect(capped.window).toBeUndefined();
  });
});
