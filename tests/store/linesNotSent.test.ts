import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import { registerMessageHandlers } from "../../src/store/handlers/messages";
import type { Message } from "../../src/types";

// Lines dropped before they left must show in the chat they were meant for,
// since nothing else tells the user that part of a long send is missing.
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

const rows = (bufferId = "c1") =>
  (useStore.getState().messages[`s1-${bufferId}`] ?? []).map((m) => [
    m.type,
    m.content,
    m.status,
  ]);

const drop = (lines: string[], serverId = "s1") =>
  ircClient.triggerEvent("linesNotSent", { serverId, lines });

describe("lines dropped before they left", () => {
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
      historyWindows: {},
      servers: [
        {
          id: "s1",
          name: "s1",
          host: "irc.test",
          port: 6697,
          isConnected: true,
          channels: [{ id: "c1", name: "#Chan", users: [], messages: [] }],
          privateChats: [{ id: "p1", username: "Bob" }],
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

  it("posts one row with the count into the chat", () => {
    drop(["PRIVMSG #chan :a", "PRIVMSG #chan :b", "PRIVMSG #chan :c"]);
    expect(rows()).toEqual([["error", "Not delivered: 3 lines", undefined]]);
  });

  it("counts a single line in the singular", () => {
    drop(["PRIVMSG #chan :a"]);
    expect(rows()).toEqual([["error", "Not delivered: 1 line", undefined]]);
  });

  it("gives each chat its own count", () => {
    drop(["PRIVMSG #chan :a", "PRIVMSG bob :b", "PRIVMSG #chan :c"]);
    expect(rows()).toEqual([["error", "Not delivered: 2 lines", undefined]]);
    expect(rows("p1")).toEqual([["error", "Not delivered: 1 line", undefined]]);
  });

  it("fails the pending line of a labelled message and posts no row", () => {
    useStore.getState().addMessage(pending("typed", "l1"));
    drop(["@label=l1 PRIVMSG #chan :typed"]);
    expect(rows()).toEqual([["message", "typed", "failed"]]);
  });

  it("fails one pending line for the two parts of a long labelled message", () => {
    useStore.getState().addMessage(pending("typed", "l1"));
    drop([
      "@label=l1 PRIVMSG #chan :first half",
      "@label=l1 PRIVMSG #chan :rest",
    ]);
    expect(rows()).toEqual([["message", "typed", "failed"]]);
  });

  it("counts a labelled line whose message the server already confirmed", () => {
    useStore.getState().addMessage(pending("typed", "l1"));
    useStore.getState().confirmPendingMessage("s1", "c1", "l1", {});
    drop(["@label=l1 PRIVMSG #chan :rest"]);
    expect(rows()).toEqual([
      ["message", "typed", undefined],
      ["error", "Not delivered: 1 line", undefined],
    ]);
  });

  it("reports a whisper in its channel when the nick has no chat open", () => {
    drop(["@+channel-context=#chan PRIVMSG carol :psst"]);
    expect(rows()).toEqual([["error", "Not delivered: 1 line", undefined]]);
  });

  it("reports a whisper in its channel, where it is shown, when the nick has a chat open too", () => {
    drop(["@+channel-context=#chan PRIVMSG bob :psst"]);
    expect(rows()).toEqual([["error", "Not delivered: 1 line", undefined]]);
    expect(rows("p1")).toEqual([]);
  });

  it("fails the pending line of a chat that went back to show the past", () => {
    useStore.setState({
      messages: { "s1-c1": [] },
      historyWindows: {
        "s1-c1": { until: 1000, present: [pending("typed", "l1")] },
      },
    });
    drop(["@label=l1 PRIVMSG #chan :typed"]);
    const { historyWindows } = useStore.getState();
    expect(
      historyWindows["s1-c1"]?.present.map((m) => [m.content, m.status]),
    ).toEqual([["typed", "failed"]]);
    expect(rows()).toEqual([]);
  });

  it("skips a line for a chat we do not have", () => {
    expect(() =>
      drop(["PRIVMSG #elsewhere :a", "PRIVMSG carol :b"]),
    ).not.toThrow();
    expect(useStore.getState().messages).toEqual({});
  });

  it("skips a server we do not have", () => {
    drop(["PRIVMSG #chan :a"], "gone");
    expect(useStore.getState().messages).toEqual({});
  });
});
