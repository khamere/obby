import { beforeEach, describe, expect, it } from "vitest";
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
