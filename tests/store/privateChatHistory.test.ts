import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import {
  chathistoryBuffers,
  reactionBuffers,
} from "../../src/store/handlers/batches";
import { MAX_MESSAGES_PER_CHANNEL } from "../../src/store/helpers";
import type { Message, PrivateChat, Server } from "../../src/types";

const chat = (username = "mrkmrtns"): PrivateChat => ({
  id: username,
  username,
  serverId: "s1",
  unreadCount: 0,
  isMentioned: false,
});
const message = (id: string, time: string): Message => ({
  id,
  msgid: id,
  type: "message",
  content: id,
  timestamp: new Date(time),
  userId: "mrkmrtns",
  channelId: "mrkmrtns",
  serverId: "s1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
});
const pm = () => useStore.getState().servers[0].privateChats?.[0];
const messages = () => useStore.getState().messages["s1-mrkmrtns"];

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), "s1");
}

function completePage(pending: Message[]) {
  ircClient.triggerEvent("BATCH_START", {
    serverId: "s1",
    batchId: "pm-history",
    type: "chathistory",
    parameters: ["Mrkmrtns"],
  });
  chathistoryBuffers.set("pm-history", pending);
  ircClient.triggerEvent("BATCH_END", {
    serverId: "s1",
    batchId: "pm-history",
  });
}

describe("private chat history batches", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    ircClient.nicks.set("s1", "demonkadar");
    chathistoryBuffers.clear();
    reactionBuffers.clear();
    useStore.setState({
      servers: [
        {
          id: "s1",
          name: "DKOKTO",
          host: "irc.dkok.to",
          port: 42069,
          isConnected: true,
          users: [],
          channels: [],
          privateChats: [chat(), chat("someone-else")],
          capabilities: ["draft/chathistory"],
        } as Server,
      ],
      messages: { "s1-mrkmrtns": [message("recent", "2026-10-10T15:03:00Z")] },
      activeBatches: {},
      processedMessageIds: new Set(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete("s1");
    ircClient.activeBatches.delete("s1");
  });

  it("keeps older history available after real incoming and outgoing PRIVMSG replay", () => {
    feed(
      ":soju BATCH +replay chathistory mrkmrtns",
      "@batch=replay;msgid=received;time=2026-10-10T14:00:00Z :mrkmrtns!u@host PRIVMSG demonkadar :earlier reply",
      "@batch=replay;msgid=sent;time=2026-10-10T14:01:00Z :demonkadar!u@host PRIVMSG mrkmrtns :earlier send",
    );
    expect(messages()).toHaveLength(1);
    feed(":soju BATCH -replay");
    expect(messages().map((m) => m.msgid)).toEqual([
      "received",
      "sent",
      "recent",
    ]);
    expect(pm()?.hasMoreHistory).toBe(true);
    expect(pm()?.unreadCount).toBe(0);
    expect(pm()?.isOnline).toBeUndefined();

    // Reopening a pinned PM can fetch the same already-processed page again.
    feed(
      ":soju BATCH +repeat chathistory mrkmrtns",
      "@batch=repeat;msgid=received;time=2026-10-10T14:00:00Z :mrkmrtns!u@host PRIVMSG demonkadar :earlier reply",
      ":soju BATCH -repeat",
    );
    expect(messages()).toHaveLength(3);
    expect(pm()?.hasMoreHistory).toBe(true);
    feed(":soju BATCH +empty chathistory mrkmrtns", ":soju BATCH -empty");
    expect(pm()?.hasMoreHistory).toBe(false);
  });

  it.each([
    "mrkmrtns",
    "demonkadar",
  ])("buffers nested multiline history from %s", (sender) => {
    const target = sender === "mrkmrtns" ? "demonkadar" : "mrkmrtns";
    feed(
      ":soju BATCH +history chathistory mrkmrtns",
      `@batch=history;msgid=multi;time=2026-10-10T14:00:00Z :${sender}!u@host BATCH +multi draft/multiline ${target}`,
      `@batch=multi;msgid=line1 :${sender}!u@host PRIVMSG ${target} :first line`,
      `@batch=multi;msgid=line2 :${sender}!u@host PRIVMSG ${target} :second line`,
      ":soju BATCH -multi",
      ":soju BATCH -history",
    );
    expect(messages()[0].content).toBe("first line\nsecond line");
    expect(messages()).toHaveLength(2);
    expect(pm()?.hasMoreHistory).toBe(true);
  });

  it("retains an actual replayed older page beyond the cache limit", () => {
    useStore.setState({
      messages: {
        "s1-mrkmrtns": Array.from(
          { length: MAX_MESSAGES_PER_CHANNEL },
          (_, i) => message(`cached-${i}`, "2026-10-10T15:03:00Z"),
        ),
      },
    });
    feed(
      ":soju BATCH +history chathistory mrkmrtns",
      "@batch=history;msgid=older;time=2026-10-10T14:00:00Z :mrkmrtns!u@host PRIVMSG demonkadar :older message",
      ":soju BATCH -history",
    );
    expect(messages()).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 1);
    expect(messages()[0].msgid).toBe("older");
    expect(pm()?.hasMoreHistory).toBe(true);
  });

  it("tracks loading only for the requested private conversation", () => {
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId: "s1",
      channelName: "MRKMRTNS",
      isLoading: true,
    });
    expect(pm()?.isLoadingHistory).toBe(true);
    expect(
      useStore.getState().servers[0].privateChats?.[1].isLoadingHistory,
    ).toBeUndefined();
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId: "other-server",
      channelName: "mrkmrtns",
      isLoading: false,
    });
    expect(pm()?.isLoadingHistory).toBe(true);
  });

  it("prepends and deduplicates older PMs, clears loading and allows another request", () => {
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId: "s1",
      channelName: "mrkmrtns",
      isLoading: true,
    });
    completePage([
      message("older", "2026-10-10T14:00:00Z"),
      message("recent", "2026-10-10T15:03:00Z"),
    ]);
    expect(messages().map((m) => m.id)).toEqual(["older", "recent"]);
    expect(pm()?.isLoadingHistory).toBe(false);
    expect(pm()?.hasMoreHistory).toBe(true);
    expect(chathistoryBuffers.has("pm-history")).toBe(false);
  });

  it("stops at an empty batch without removing existing messages", () => {
    completePage([]);
    expect(pm()?.hasMoreHistory).toBe(false);
    expect(pm()?.isLoadingHistory).toBe(false);
    expect(messages().map((m) => m.id)).toEqual(["recent"]);
  });

  it("keeps pagination available when a nonempty batch only repeats cached messages", () => {
    completePage([message("recent", "2026-10-10T15:03:00Z")]);
    expect(messages()).toHaveLength(1);
    expect(pm()?.hasMoreHistory).toBe(true);
  });

  it("retains requested older pages after reaching the recent-message cache limit", () => {
    const cached = Array.from({ length: MAX_MESSAGES_PER_CHANNEL }, (_, i) =>
      message(`cached-${i}`, "2026-10-10T15:03:00Z"),
    );
    useStore.setState({ messages: { "s1-mrkmrtns": cached } });
    completePage([message("older", "2026-10-10T14:00:00Z")]);
    expect(messages()).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 1);
    expect(messages()[0].id).toBe("older");
  });
});
