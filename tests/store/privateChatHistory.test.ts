import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import {
  chathistoryBuffers,
  historyBufferKey,
  historyEditBuffers,
} from "../../src/store/handlers/batches";
import type { Message, PrivateChat, Server } from "../../src/types";

const chat = (username = "kestrel"): PrivateChat => ({
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
  userId: "kestrel",
  channelId: "kestrel",
  serverId: "s1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
});
const pm = () => useStore.getState().servers[0].privateChats?.[0];
const messages = () => useStore.getState().messages["s1-kestrel"];

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
    parameters: ["Kestrel"],
  });
  chathistoryBuffers.set(historyBufferKey("s1", "pm-history"), pending);
  ircClient.triggerEvent("BATCH_END", {
    serverId: "s1",
    batchId: "pm-history",
  });
}

describe("private chat history batches", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    ircClient.nicks.set("s1", "eliska");
    chathistoryBuffers.clear();
    historyEditBuffers.clear();
    useStore.setState({
      servers: [
        {
          id: "s1",
          name: "Pebble",
          host: "irc.pebble.example",
          port: 6697,
          isConnected: true,
          users: [],
          channels: [],
          privateChats: [chat(), chat("someone-else")],
          capabilities: ["draft/chathistory"],
        } as Server,
      ],
      messages: { "s1-kestrel": [message("recent", "2026-10-10T15:03:00Z")] },
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
      ":soju BATCH +replay chathistory kestrel",
      "@batch=replay;msgid=received;time=2026-10-10T14:00:00Z :kestrel!u@host PRIVMSG eliska :earlier reply",
      "@batch=replay;msgid=sent;time=2026-10-10T14:01:00Z :eliska!u@host PRIVMSG kestrel :earlier send",
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
      ":soju BATCH +repeat chathistory kestrel",
      "@batch=repeat;msgid=received;time=2026-10-10T14:00:00Z :kestrel!u@host PRIVMSG eliska :earlier reply",
      ":soju BATCH -repeat",
    );
    expect(messages()).toHaveLength(3);
    expect(pm()?.hasMoreHistory).toBe(true);
    feed(":soju BATCH +empty chathistory kestrel", ":soju BATCH -empty");
    expect(pm()?.hasMoreHistory).toBe(false);
  });

  it.each(["kestrel", "eliska"])(
    "buffers nested multiline history from %s",
    (sender) => {
      const target = sender === "kestrel" ? "eliska" : "kestrel";
      feed(
        ":soju BATCH +history chathistory kestrel",
        `@batch=history;msgid=multi;time=2026-10-10T14:00:00Z :${sender}!u@host BATCH +multi draft/multiline ${target}`,
        `@batch=multi;msgid=line1 :${sender}!u@host PRIVMSG ${target} :first line`,
        `@batch=multi;msgid=line2 :${sender}!u@host PRIVMSG ${target} :second line`,
        ":soju BATCH -multi",
        ":soju BATCH -history",
      );
      expect(messages()[0].content).toBe("first line\nsecond line");
      expect(messages()).toHaveLength(2);
      expect(pm()?.hasMoreHistory).toBe(true);
    },
  );

  it("tracks loading only for the requested private conversation", () => {
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId: "s1",
      channelName: "KESTREL",
      isLoading: true,
    });
    expect(pm()?.isLoadingHistory).toBe(true);
    expect(
      useStore.getState().servers[0].privateChats?.[1].isLoadingHistory,
    ).toBeUndefined();
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId: "other-server",
      channelName: "kestrel",
      isLoading: false,
    });
    expect(pm()?.isLoadingHistory).toBe(true);
  });

  it("prepends and deduplicates older PMs, clears loading and allows another request", () => {
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId: "s1",
      channelName: "kestrel",
      isLoading: true,
    });
    completePage([
      message("older", "2026-10-10T14:00:00Z"),
      message("recent", "2026-10-10T15:03:00Z"),
    ]);
    expect(messages().map((m) => m.id)).toEqual(["older", "recent"]);
    expect(pm()?.isLoadingHistory).toBe(false);
    expect(pm()?.hasMoreHistory).toBe(true);
    expect(chathistoryBuffers.has(historyBufferKey("s1", "pm-history"))).toBe(
      false,
    );
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
});
