import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptIdKeyedMutes,
  type ChatRef,
  chatMute,
  isServerMuted,
  isSilenced,
  moveChatMute,
  muteChat,
  muteServer,
  nextMuteExpiry,
  resetMutesForTests,
  setMuteChatSource,
  silencesFor,
  unmuteChat,
  unmuteServer,
} from "../../src/lib/mutes";
import { shouldPlayNotificationSound } from "../../src/lib/notificationSounds";
import { generateDeterministicId } from "../../src/store/helpers";

// We count how often a chat id is derived: each one is a SHA-1 hash, and the
// app looks for mutes to name on every change of its servers.
const hashes = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/store/helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/store/helpers")>();
  return {
    ...actual,
    generateDeterministicId: (serverId: string, name: string) => {
      hashes.count++;
      return actual.generateDeterministicId(serverId, name);
    },
  };
});

const HOUR = 60 * 60 * 1000;

const chan: ChatRef = { id: "chan", kind: "channel", name: "#chan" };
const dev: ChatRef = { id: "c-dev", kind: "channel", name: "#dev" };
const bob: ChatRef = { id: "p-bob", kind: "dm", name: "bob" };

// The chats the app has loaded for s1, which is where an id gets its name.
const loaded = (...chats: ChatRef[]) => [
  {
    id: "s1",
    channels: chats
      .filter((c) => c.kind === "channel")
      .map((c) => ({ id: c.id ?? "", name: c.name })),
    privateChats: chats
      .filter((c) => c.kind === "dm")
      .map((c) => ({ id: c.id ?? "", username: c.name })),
  },
];

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
    setMuteChatSource(() => loaded(chan, dev, bob));
  });
  afterEach(() => {
    setMuteChatSource(() => []);
    vi.restoreAllMocks();
  });

  it("a muted server silences everything in it, mentions included", () => {
    muteServer("s1", null);
    expect(isSilenced("s1", "chan", true)).toBe(true);
    expect(isSilenced("s1", "dm", false)).toBe(true);
    expect(isSilenced("s2", "chan", false)).toBe(false);
  });

  it("a muted channel silences mentions too", () => {
    muteChat("s1", chan, null);
    expect(isSilenced("s1", "chan", false)).toBe(true);
    expect(isSilenced("s1", "chan", true)).toBe(true);
    expect(isSilenced("s1", "other", false)).toBe(false);
    expect(chatMute("s1", "chan")?.kind).toBe("channel");
  });

  it("a muted DM is fully silent", () => {
    muteChat("s1", bob, null);
    expect(isSilenced("s1", "p-bob", true)).toBe(true);
  });

  it("timed mutes expire", () => {
    const now = Date.now();
    muteServer("s1", now + HOUR);
    muteChat("s1", chan, now + 8 * HOUR);
    expect(isServerMuted("s1", now + HOUR - 1)).toBe(true);
    expect(isServerMuted("s1", now + HOUR + 1)).toBe(false);
    expect(chatMute("s1", "chan", now + 9 * HOUR)).toBeUndefined();
  });

  it("names the earliest timed mute's end", () => {
    const now = Date.now();
    expect(nextMuteExpiry(now)).toBeUndefined();
    muteServer("s1", null);
    expect(nextMuteExpiry(now)).toBeUndefined();
    muteChat("s1", dev, now + 2 * HOUR);
    muteChat("s1", bob, now + HOUR);
    expect(nextMuteExpiry(now)).toBe(now + HOUR);
    expect(nextMuteExpiry(now + HOUR)).toBe(now + 2 * HOUR);
  });

  it("unmuting works and mutes survive a reload", () => {
    muteServer("s1", null);
    muteChat("s1", chan, null);
    resetMutesForTests(); // reload: state comes back from storage
    expect(isServerMuted("s1")).toBe(true);
    expect(chatMute("s1", "chan")).toBeDefined();
    unmuteServer("s1");
    unmuteChat("s1", "chan");
    expect(isSilenced("s1", "chan", false)).toBe(false);
  });

  it("lists every mute by chat name for the background side", () => {
    const server = {
      id: "s1",
      channels: [
        { id: "c-dev", name: "#dev" },
        { id: "c-ops", name: "#ops" },
      ],
      privateChats: [{ id: "p-bob", username: "bob" }],
    };
    const now = Date.now();
    muteChat("s1", dev, null);
    muteChat("s1", bob, now + HOUR);
    expect(silencesFor(server, now)).toEqual([
      { chat: "#dev", until: null },
      { chat: "bob", until: now + HOUR },
    ]);
    expect(silencesFor(server, now + 2 * HOUR)).toEqual([
      { chat: "#dev", until: null },
    ]);
    muteServer("s1", null);
    expect(silencesFor(server, now)[0]).toEqual({ chat: "*", until: null });
  });

  describe("a chat is muted by name, whatever id it has now", () => {
    const idOf = (name: string) => generateDeterministicId("s1", name);
    const dm = (name: string): ChatRef => ({
      id: idOf(name),
      kind: "dm",
      name,
    });
    const nothingLoaded = { id: "s1", channels: [], privateChats: [] };

    it("keeps a DM muted when the chat comes back under another spelling", () => {
      muteChat("s1", dm("Mara"), null);
      // The chat was closed and reopened from a casefolded name: a new id.
      setMuteChatSource(() => loaded(dm("mara")));
      expect(idOf("mara")).not.toBe(idOf("Mara"));
      expect(isSilenced("s1", idOf("mara"), false)).toBe(true);
      // What the bell and the mute dialog read.
      expect(chatMute("s1", idOf("mara"))?.until).toBeNull();
      expect(chatMute("s1", dm("MARA"))?.kind).toBe("dm");
    });

    it("keeps it muted after a reload", () => {
      muteChat("s1", dm("Mara"), null);
      resetMutesForTests();
      setMuteChatSource(() => loaded(dm("mara")));
      expect(isSilenced("s1", idOf("mara"), true)).toBe(true);
    });

    it("keeps a channel and a DM apart", () => {
      muteChat("s1", { kind: "channel", name: "#mara" }, null);
      expect(chatMute("s1", { kind: "dm", name: "#mara" })).toBeUndefined();
      expect(chatMute("s1", dm("mara"))).toBeUndefined();
    });

    it("names a mute for the background side while its chat is not loaded", () => {
      const now = Date.now();
      muteChat("s1", dm("Mara"), null);
      muteChat("s1", dev, now + HOUR);
      expect(silencesFor(nothingLoaded, now)).toEqual([
        { chat: "Mara", until: null },
        { chat: "#dev", until: now + HOUR },
      ]);
      expect(silencesFor(nothingLoaded, now + 2 * HOUR)).toEqual([
        { chat: "Mara", until: null },
      ]);
      expect(
        silencesFor({ id: "s2", channels: [], privateChats: [] }, now),
      ).toEqual([]);
    });

    it("unmutes under any spelling", () => {
      muteChat("s1", dm("Mara"), null);
      unmuteChat("s1", dm("mara"));
      expect(chatMute("s1", dm("Mara"))).toBeUndefined();
      muteChat("s1", dm("Mara"), null);
      setMuteChatSource(() => loaded(dm("MARA")));
      unmuteChat("s1", idOf("MARA"));
      expect(isSilenced("s1", idOf("MARA"), false)).toBe(false);
      expect(backing.get("obby.mutes")).toBe('{"servers":{},"chats":{}}');
    });

    it("lets a timed mute run out", () => {
      const now = Date.now();
      muteChat("s1", dm("Mara"), now + HOUR);
      setMuteChatSource(() => loaded(dm("mara")));
      expect(isSilenced("s1", idOf("mara"), false, now + HOUR - 1)).toBe(true);
      expect(isSilenced("s1", idOf("mara"), false, now + HOUR + 1)).toBe(false);
      expect(chatMute("s1", dm("mara"), now + HOUR + 1)).toBeUndefined();
    });

    it("moves a DM's mute to the person's new nick", () => {
      const now = Date.now();
      muteChat("s1", dm("mara"), now + HOUR);
      moveChatMute("s1", "dm", "Mara", "mara_afk");
      expect(chatMute("s1", dm("mara"), now)).toBeUndefined();
      expect(chatMute("s1", dm("Mara_AFK"), now)?.until).toBe(now + HOUR);
      expect(silencesFor(nothingLoaded, now)).toEqual([
        { chat: "mara_afk", until: now + HOUR },
      ]);
      // Nobody muted: nothing to move, nothing to write.
      vi.mocked(localStorage.setItem).mockClear();
      moveChatMute("s1", "dm", "alice", "alice_afk");
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });
  });

  describe("a mute stored under a chat id, with no name", () => {
    const stored = (chats: Record<string, unknown>) => {
      backing.set("obby.mutes", JSON.stringify({ servers: {}, chats }));
      resetMutesForTests();
    };
    const saved = () => JSON.parse(backing.get("obby.mutes") ?? "{}").chats;
    const nothingLoaded = { id: "s1", channels: [], privateChats: [] };

    it("still silences that id and is named through the loaded chats", () => {
      stored({ "s1/p-bob": { until: null, kind: "dm" } });
      setMuteChatSource(() => []);
      expect(isSilenced("s1", "p-bob", true)).toBe(true);
      expect(chatMute("s1", bob)?.kind).toBe("dm");
      expect(
        silencesFor({
          id: "s1",
          channels: [],
          privateChats: [{ id: "p-bob", username: "bob" }],
        }),
      ).toEqual([{ chat: "bob", until: null }]);
    });

    it("stays as it is until its chat is known", () => {
      stored({ "s1/p-bob": { until: null, kind: "dm" } });
      setMuteChatSource(() => loaded(chan));
      adoptIdKeyedMutes();
      expect(isSilenced("s1", "p-bob", true)).toBe(true);
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });

    it("takes the chat's name once the chat is known, and keeps it across a reload", () => {
      const now = Date.now();
      stored({
        "s1/p-bob": { until: now + HOUR, kind: "dm" },
        "s1/c-dev": { until: null, kind: "channel" },
      });
      setMuteChatSource(() => loaded(bob, dev));
      adoptIdKeyedMutes();
      expect(saved()).toEqual({
        "s1/dm:bob": { until: now + HOUR, kind: "dm", name: "bob" },
        "s1/channel:#dev": { until: null, kind: "channel", name: "#dev" },
      });
      resetMutesForTests();
      setMuteChatSource(() => []);
      expect(chatMute("s1", { kind: "dm", name: "Bob" })?.until).toBe(
        now + HOUR,
      );
      expect(silencesFor(nothingLoaded, now)).toEqual(
        expect.arrayContaining([
          { chat: "bob", until: now + HOUR },
          { chat: "#dev", until: null },
        ]),
      );
    });

    it("is recognised when the chat was since recreated under another spelling", () => {
      stored({
        [`s1/${generateDeterministicId("s1", "mara")}`]: {
          until: null,
          kind: "dm",
        },
      });
      const mara: ChatRef = {
        id: generateDeterministicId("s1", "Mara"),
        kind: "dm",
        name: "Mara",
      };
      setMuteChatSource(() => loaded(mara));
      expect(isSilenced("s1", mara.id, true)).toBe(false);
      adoptIdKeyedMutes();
      expect(isSilenced("s1", mara.id, true)).toBe(true);
      expect(saved()).toEqual({
        "s1/dm:mara": { until: null, kind: "dm", name: "Mara" },
      });
    });

    it("is named through the chat's own id without deriving any", () => {
      stored({ "s1/p-bob": { until: null, kind: "dm" } });
      setMuteChatSource(() => loaded(chan, dev, bob));
      hashes.count = 0;
      adoptIdKeyedMutes();
      expect(saved()).toEqual({
        "s1/dm:bob": { until: null, kind: "dm", name: "bob" },
      });
      expect(hashes.count).toBe(0);
    });

    it("derives a chat's ids once, however often we look while it waits", () => {
      stored({ "s1/gone": { until: null, kind: "channel" } });
      setMuteChatSource(() => loaded(chan, dev, bob));
      adoptIdKeyedMutes();
      hashes.count = 0;
      for (let i = 0; i < 5; i++) adoptIdKeyedMutes();
      expect(hashes.count).toBe(0);
      expect(isSilenced("s1", "gone", true)).toBe(true);

      const alice: ChatRef = { id: "p-alice", kind: "dm", name: "alice" };
      setMuteChatSource(() => loaded(chan, dev, bob, alice));
      adoptIdKeyedMutes();
      adoptIdKeyedMutes();
      expect(hashes.count).toBe(2);
    });

    it("names every entry of a chat that sits under more than one id", () => {
      const now = Date.now();
      stored({
        "s1/p-bob": { until: now + HOUR, kind: "dm" },
        [`s1/${generateDeterministicId("s1", "bob")}`]: {
          until: now + HOUR,
          kind: "dm",
        },
      });
      setMuteChatSource(() => loaded(bob));
      adoptIdKeyedMutes();
      expect(saved()).toEqual({
        "s1/dm:bob": { until: now + HOUR, kind: "dm", name: "bob" },
      });
    });

    it("is removed by unmuting, and replaced by muting again", () => {
      stored({ "s1/p-bob": { until: null, kind: "dm" } });
      unmuteChat("s1", bob);
      expect(saved()).toEqual({});

      stored({ "s1/p-bob": { until: null, kind: "dm" } });
      setMuteChatSource(() => []);
      unmuteChat("s1", "p-bob");
      expect(saved()).toEqual({});

      const now = Date.now();
      stored({ "s1/p-bob": { until: null, kind: "dm" } });
      muteChat("s1", bob, now + HOUR);
      expect(saved()).toEqual({
        "s1/dm:bob": { until: now + HOUR, kind: "dm", name: "bob" },
      });
    });

    it("expires like any other", () => {
      const now = Date.now();
      stored({ "s1/p-bob": { until: now + HOUR, kind: "dm" } });
      expect(isSilenced("s1", "p-bob", true, now + HOUR + 1)).toBe(false);
    });
  });

  it("a whole-server mute covers chats that are not loaded", () => {
    muteServer("s1", null);
    setMuteChatSource(() => []);
    expect(isSilenced("s1", "unknown-id", false)).toBe(true);
    expect(silencesFor({ id: "s1", channels: [], privateChats: [] })).toEqual([
      { chat: "*", until: null },
    ]);
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
    muteChat("s1", chan, null);
    expect(
      shouldPlayNotificationSound(msg("chan", "hi all"), me, settings),
    ).toBe(false);
    // a mention in a muted channel is silent too
    expect(
      shouldPlayNotificationSound(msg("chan", "hi me"), me, settings),
    ).toBe(false);
    muteServer("s1", null);
    expect(
      shouldPlayNotificationSound(msg("chan", "hi me"), me, settings),
    ).toBe(false);
  });
});
