import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import { MAX_MENTIONS, unseenMentions } from "../../src/store/mentionLog";
import type { Channel, Server } from "../../src/types";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: () => false,
}));

const channel = (id: string, name: string): Channel => ({
  id,
  name,
  isPrivate: false,
  serverId: "s1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
});

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), "s1");
}

const log = () => useStore.getState().mentionLog;

describe("mention log", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    vi.spyOn(ircClient, "getCurrentUser").mockReturnValue({
      id: "u1",
      username: "me",
    } as never);
    ircClient.nicks.set("s1", "me");
    useStore.setState((state) => ({
      servers: [
        {
          id: "s1",
          name: "Test",
          host: "irc.example",
          port: 6697,
          isConnected: true,
          users: [],
          channels: [channel("c1", "#one"), channel("c2", "#two")],
          privateChats: [],
          capabilities: [],
        } as Server,
      ],
      messages: {},
      mentionLog: [],
      activeBatches: {},
      processedMessageIds: new Set(),
      ui: {
        ...state.ui,
        selectedServerId: "s1",
        perServerSelections: {
          s1: { selectedChannelId: "c1", selectedPrivateChatId: null },
        },
        jumpRequest: null,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete("s1");
  });

  it("records mentions, seen only in the open channel", () => {
    feed(
      "@msgid=a :bob!u@h PRIVMSG #two :hey me, look",
      "@msgid=b :bob!u@h PRIVMSG #one :me: here too",
      "@msgid=c :bob!u@h PRIVMSG #two :no ping here",
      "@msgid=d :me!u@h PRIVMSG #two :me talking about me",
    );
    expect(log().map((m) => [m.msgid, m.channelName, m.seen])).toEqual([
      ["a", "#two", false],
      ["b", "#one", true],
    ]);
    expect(log()[0]).toMatchObject({ sender: "bob", content: "hey me, look" });
  });

  it("skips history replay and duplicates", () => {
    feed(
      ":server BATCH +h chathistory #two",
      "@batch=h;msgid=old :bob!u@h PRIVMSG #two :me old ping",
      ":server BATCH -h",
      "@msgid=a :bob!u@h PRIVMSG #two :me",
    );
    useStore.getState().recordMention({ ...log()[0], messageId: "copy" });
    expect(log().map((m) => m.msgid)).toEqual(["a"]);
  });

  it("jumps to a mention and marks it seen", () => {
    feed(
      "@msgid=a :bob!u@h PRIVMSG #two :me first",
      "@msgid=b :bob!u@h PRIVMSG #two :me second",
    );
    useStore.getState().jumpToMention(log()[0]);
    expect(useStore.getState().ui.jumpRequest).toEqual({
      channelKey: "s1-c2",
      target: "a",
    });
    expect(unseenMentions(log(), "s1-c2").map((m) => m.msgid)).toEqual(["b"]);

    useStore.getState().dismissMentions("s1-c2");
    expect(unseenMentions(log(), "s1-c2")).toEqual([]);
  });

  it("keeps only the newest mentions", () => {
    for (let i = 0; i < MAX_MENTIONS + 5; i++) {
      feed(`@msgid=m${i} :bob!u@h PRIVMSG #two :me ${i}`);
    }
    expect(log()).toHaveLength(MAX_MENTIONS);
    expect(log()[0].msgid).toBe("m5");
  });
});
