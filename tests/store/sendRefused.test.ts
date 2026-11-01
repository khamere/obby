import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import { registerMessageHandlers } from "../../src/store/handlers/messages";
import type { Message } from "../../src/types";

// When the server refuses a message, the user sees it fail with the reason
// instead of a line that stays "sending" forever.
const pending = (id: string, label: string): Message => ({
  id,
  content: id,
  timestamp: new Date(),
  userId: "me",
  channelId: "c1",
  serverId: "s1",
  type: "message",
  reactions: [],
  replyMessage: null,
  mentioned: [],
  pendingLabel: label,
  status: "pending",
});

const lines = () => useStore.getState().messages["s1-c1"] ?? [];

describe("a refused send", () => {
  let saved: Record<string, unknown[]>;

  beforeEach(() => {
    const c = ircClient as unknown as {
      eventCallbacks: Record<string, unknown[]>;
    };
    saved = c.eventCallbacks;
    c.eventCallbacks = {};
    registerMessageHandlers(useStore);
    useStore.setState({
      messages: {},
      servers: [
        {
          id: "s1",
          name: "s1",
          host: "irc.test",
          port: 6697,
          isConnected: true,
          channels: [{ id: "c1", name: "#Chan", users: [], messages: [] }],
          privateChats: [],
          users: [],
        },
      ],
    } as never);
  });

  afterEach(() => {
    (
      ircClient as unknown as { eventCallbacks: Record<string, unknown[]> }
    ).eventCallbacks = saved;
    vi.restoreAllMocks();
  });

  it("fails the labelled line with the server's reason", () => {
    useStore.getState().addMessage(pending("one", "l1"));
    useStore.getState().addMessage(pending("two", "l2"));
    ircClient.triggerEvent("SEND_REFUSED", {
      serverId: "s1",
      target: "#chan",
      reason: "Cannot send to channel (+m)",
      label: "l1",
    });
    expect(lines().map((m) => [m.content, m.status, m.failReason])).toEqual([
      ["one", "failed", "Cannot send to channel (+m)"],
      ["two", "pending", undefined],
    ]);
  });

  it("fails the newest pending line when the refusal has no label", () => {
    useStore.getState().addMessage(pending("one", "l1"));
    useStore.getState().addMessage(pending("two", "l2"));
    ircClient.triggerEvent("SEND_REFUSED", {
      serverId: "s1",
      target: "#chan",
      reason: "You are banned",
    });
    expect(lines().map((m) => [m.content, m.status])).toEqual([
      ["one", "pending"],
      ["two", "failed"],
    ]);
  });

  it("posts the reason into the chat when nothing was pending but we just sent", () => {
    vi.spyOn(ircClient, "takeRecentSend").mockReturnValue(true);
    ircClient.triggerEvent("SEND_REFUSED", {
      serverId: "s1",
      target: "#chan",
      reason: "Cannot send to channel",
    });
    expect(lines().map((m) => [m.type, m.content])).toEqual([
      ["error", "Not delivered: Cannot send to channel"],
    ]);
  });

  it("ignores a refusal of something that was not a message, such as a typing notice", () => {
    ircClient.triggerEvent("SEND_REFUSED", {
      serverId: "s1",
      target: "#chan",
      reason: "Cannot send to channel",
    });
    expect(lines()).toEqual([]);
  });
});
