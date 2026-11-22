import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  mentionLog,
  servers,
  settings,
  uiSelections,
} from "../../src/store/localStorage";

describe("settings.load migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockStored(value: object | null): void {
    vi.mocked(window.localStorage.getItem).mockReturnValue(
      value === null ? null : JSON.stringify(value),
    );
  }

  test("returns empty object when nothing is stored", () => {
    mockStored(null);
    const result = settings.load();
    // Migration still runs (no mediaVisibilityLevel in null → defaults to 1)
    expect(result.mediaVisibilityLevel).toBe(1);
  });

  test("migrates showSafeMedia=true to level 1", () => {
    mockStored({ showSafeMedia: true });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(1);
    expect("showSafeMedia" in result).toBe(false);
  });

  test("migrates showSafeMedia=false to level 0", () => {
    mockStored({ showSafeMedia: false });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(0);
    expect("showSafeMedia" in result).toBe(false);
  });

  test("migrates showTrustedSourcesMedia=true to level 2", () => {
    mockStored({
      showSafeMedia: true,
      showTrustedSourcesMedia: true,
      showExternalContent: false,
    });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(2);
    expect("showTrustedSourcesMedia" in result).toBe(false);
  });

  test("migrates showExternalContent=true to level 3", () => {
    mockStored({
      showSafeMedia: true,
      showTrustedSourcesMedia: true,
      showExternalContent: true,
    });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(3);
    expect("showExternalContent" in result).toBe(false);
  });

  test("most-permissive wins: showExternalContent overrides lower flags", () => {
    mockStored({
      showSafeMedia: false,
      showTrustedSourcesMedia: false,
      showExternalContent: true,
    });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(3);
  });

  test("does not migrate if mediaVisibilityLevel already present", () => {
    mockStored({ mediaVisibilityLevel: 2, showSafeMedia: true });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(2);
    // Old flag is left as-is when not migrating (no need to clean it up)
  });

  test("returns empty object on invalid JSON", () => {
    vi.mocked(window.localStorage.getItem).mockReturnValue("not-json");
    const result = settings.load();
    expect(result).toEqual({});
  });
});

describe("uiSelections.load", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("never restores a voice or stream channel, so a call does not rejoin at startup", () => {
    vi.mocked(window.localStorage.getItem).mockReturnValue(
      JSON.stringify({
        selectedServerId: "s1",
        perServerSelections: {
          s1: {
            selectedChannelId: "id-tv",
            selectedChannelName: "$tv",
            selectedPrivateChatId: null,
          },
          s2: {
            selectedChannelId: "id-dev",
            selectedChannelName: "#dev",
            selectedPrivateChatId: null,
          },
        },
        lastSelection: {
          serverHost: "irc.example.com",
          channelName: "^voice",
          privateChatUsername: null,
        },
      }),
    );

    const loaded = uiSelections.load();

    expect(loaded.perServerSelections.s1.selectedChannelId).toBeNull();
    expect(loaded.perServerSelections.s2.selectedChannelId).toBe("id-dev");
    expect(loaded.lastSelection?.channelName).toBeNull();
  });
});

describe("servers.load", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test.each([
    ["an empty string", ""],
    ["null", null],
    ["an object", { name: "#lobby" }],
    ["a missing field", undefined],
  ])(
    "reads a saved server whose channels is %s as one with no channels",
    (_, channels) => {
      vi.mocked(window.localStorage.getItem).mockReturnValue(
        JSON.stringify([{ id: "srv-1", host: "irc.test", channels }]),
      );

      expect(servers.load()).toEqual([
        { id: "srv-1", host: "irc.test", channels: [] },
      ]);
    },
  );

  test("keeps a saved channel list as it is", () => {
    vi.mocked(window.localStorage.getItem).mockReturnValue(
      JSON.stringify([{ id: "srv-1", channels: ["#lobby", "#two"] }]),
    );

    expect(servers.load()[0].channels).toEqual(["#lobby", "#two"]);
  });
});

describe("mentionLog.load", () => {
  const entry = {
    messageId: "m1",
    msgid: "abc",
    serverId: "s1",
    channelId: "c1",
    channelName: "#dev",
    sender: "bob",
    content: "me: hi",
    timestamp: "2026-01-01T00:00:00.000Z",
    seen: false,
  };

  function mockStored(value: unknown): void {
    vi.mocked(window.localStorage.getItem).mockReturnValue(
      JSON.stringify(value),
    );
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("keeps well-formed entries, with or without a msgid", () => {
    const { msgid: _msgid, ...withoutMsgid } = entry;
    mockStored([entry, withoutMsgid]);
    expect(mentionLog.load()).toEqual([entry, withoutMsgid]);
  });

  test.each([
    "messageId",
    "serverId",
    "channelId",
    "channelName",
    "sender",
    "content",
    "timestamp",
  ] as const)("drops an entry saved without its %s", (field) => {
    const { [field]: _dropped, ...broken } = entry;
    mockStored([broken, entry]);
    expect(mentionLog.load()).toEqual([entry]);
  });

  test("drops entries that are not mention records", () => {
    mockStored([null, "text", 7, [], { ...entry, channelName: 5 }, entry]);
    expect(mentionLog.load()).toEqual([entry]);
  });

  test.each([
    ["an empty timestamp", { timestamp: "" }],
    ["a timestamp that is not a date", { timestamp: "yesterday" }],
    ["a seen flag saved as text", { seen: "false" }],
    ["no seen flag", { seen: undefined }],
    ["a msgid that is not text", { msgid: 7 }],
    ["a null msgid", { msgid: null }],
  ])("drops an entry saved with %s", (_case, change) => {
    mockStored([{ ...entry, ...change }, entry]);
    expect(mentionLog.load()).toEqual([entry]);
  });

  test("returns an empty log when the stored value is not a list", () => {
    mockStored({ entry });
    expect(mentionLog.load()).toEqual([]);
  });

  test("puts a log saved in arrival order into the order the lines were said", () => {
    const at = (msgid: string, timestamp: string) => ({
      ...entry,
      messageId: msgid,
      msgid,
      timestamp,
    });
    mockStored([
      at("late", "2026-01-01T12:10:00.000Z"),
      at("early", "2026-01-01T12:00:00.000Z"),
      at("middle", "2026-01-01T12:05:00.000Z"),
    ]);
    expect(mentionLog.load().map((m) => m.msgid)).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });
});
