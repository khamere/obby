import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import {
  hasUnreadMention,
  serverHasUnreadMention,
} from "../../src/lib/unreadMentions";
import useStore from "../../src/store";
import type { Channel, Message, PrivateChat, Server } from "../../src/types";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: () => false,
}));

const chat = (): PrivateChat => ({
  id: "bob",
  username: "bob",
  serverId: "s1",
  unreadCount: 0,
  isMentioned: false,
});
const channel = (): Channel => ({
  id: "c1",
  name: "#test",
  isPrivate: false,
  serverId: "s1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
});
const message = (id: string, time: string): Message => ({
  id,
  msgid: id,
  type: "message",
  content: id,
  timestamp: new Date(time),
  userId: "bob",
  channelId: "c1",
  serverId: "s1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
});

const server = () => useStore.getState().servers[0];
const pm = () => server().privateChats?.[0] as PrivateChat;
const chan = () => server().channels[0];

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), "s1");
}

function select(selection: {
  selectedChannelId: string | null;
  selectedPrivateChatId: string | null;
}) {
  useStore.setState((state) => ({
    ui: {
      ...state.ui,
      selectedServerId: "s1",
      perServerSelections: { s1: selection },
    },
  }));
}

describe("mention indicators", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    ircClient.nicks.set("s1", "me");
    useStore.setState({
      servers: [
        {
          id: "s1",
          name: "Test",
          host: "irc.example",
          port: 6697,
          isConnected: true,
          users: [],
          channels: [channel()],
          privateChats: [chat()],
          capabilities: [],
        } as Server,
      ],
      messages: {},
      activeBatches: {},
      processedMessageIds: new Set(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete("s1");
  });

  it("does not flag the DM being read as a mention", () => {
    select({ selectedChannelId: null, selectedPrivateChatId: "bob" });
    feed("@msgid=a :bob!u@h PRIVMSG me :hi");
    expect(pm().isMentioned).toBe(false);
    expect(serverHasUnreadMention(server())).toBe(false);
  });

  it("still flags a DM that is not open", () => {
    select({ selectedChannelId: "c1", selectedPrivateChatId: null });
    feed("@msgid=a :bob!u@h PRIVMSG me :hi");
    expect(hasUnreadMention(pm())).toBe(true);
    expect(serverHasUnreadMention(server())).toBe(true);
  });

  it("ignores a mention flag without a count, as the badge does", () => {
    expect(hasUnreadMention({ isMentioned: true, mentionCount: 0 })).toBe(
      false,
    );
    expect(hasUnreadMention({ isMentioned: true })).toBe(false);
  });

  it("clears badges when another session marks everything read", () => {
    useStore.setState((state) => ({
      messages: {
        "s1-c1": [message("m1", "2026-10-31T10:00:00.000Z")],
      },
      servers: state.servers.map((s) => ({
        ...s,
        channels: s.channels.map((c) => ({
          ...c,
          unreadCount: 3,
          mentionCount: 1,
          isMentioned: true,
        })),
      })),
    }));

    feed(":server MARKREAD #test timestamp=2026-10-31T09:59:59.000Z");
    expect(chan().isMentioned).toBe(true);
    expect(chan().unreadCount).toBe(3);

    feed(":server MARKREAD #test timestamp=2026-10-31T10:00:00.000Z");
    expect(chan().readMarker).toBe("2026-10-31T10:00:00.000Z");
    expect(chan().unreadCount).toBe(0);
    expect(chan().mentionCount).toBe(0);
    expect(chan().isMentioned).toBe(false);
  });

  it("clears a DM read elsewhere", () => {
    select({ selectedChannelId: "c1", selectedPrivateChatId: null });
    feed("@msgid=a;time=2026-10-31T10:00:00.000Z :bob!u@h PRIVMSG me :hi");
    expect(hasUnreadMention(pm())).toBe(true);
    feed(":server MARKREAD bob timestamp=2026-10-31T10:00:01.000Z");
    expect(pm().isMentioned).toBe(false);
    expect(pm().unreadCount).toBe(0);
  });
});
