import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import * as storage from "../../src/store/localStorage";
import type { Server } from "../../src/types";

// A private chat the user closed must stay closed across reloads, even
// though CHATHISTORY TARGETS keeps listing the conversation, until the
// other side writes something new.

const serverId = "s1";
const backing = new Map<string, string>();

function seed(privateChats: Server["privateChats"] = []) {
  ircClient.nicks.set(serverId, "me");
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "soju",
        host: "bouncer.test",
        port: 6697,
        isConnected: true,
        users: [],
        channels: [],
        privateChats,
        capabilities: ["draft/chathistory"],
      } as unknown as Server,
    ],
    messages: {},
    activeBatches: {},
    processedMessageIds: new Set(),
  });
}

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

const pmNames = () =>
  (useStore.getState().servers[0].privateChats ?? []).map((pc) => pc.username);

const alice = {
  id: "alice-id",
  username: "alice",
  serverId,
  unreadCount: 0,
  isMentioned: false,
};

describe("closed private chats and CHATHISTORY TARGETS", () => {
  beforeEach(() => {
    backing.clear();
    vi.mocked(window.localStorage.getItem).mockImplementation(
      (k: string) => backing.get(k) ?? null,
    );
    vi.mocked(window.localStorage.setItem).mockImplementation(
      (k: string, v: string) => {
        backing.set(k, v);
      },
    );
    vi.mocked(window.localStorage.removeItem).mockImplementation(
      (k: string) => {
        backing.delete(k);
      },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T20:00:00Z"));
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed([alice]);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
  });

  it("remembers when a private chat was closed", () => {
    useStore.getState().deletePrivateChat(serverId, "alice-id");
    expect(pmNames()).toEqual([]);
    expect(storage.closedChats.load()).toEqual({
      [serverId]: { alice: "2026-10-14T20:00:00.000Z" },
    });
  });

  it("does not reopen a closed chat for activity older than the close", () => {
    useStore.getState().deletePrivateChat(serverId, "alice-id");
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T19:30:00.000Z");
    vi.runOnlyPendingTimers();
    expect(pmNames()).toEqual([]);
  });

  it("reopens a closed chat when there is newer activity and forgets the close", () => {
    useStore.getState().deletePrivateChat(serverId, "alice-id");
    feed(":soju CHATHISTORY TARGETS Alice 2026-10-14T20:05:00.000Z");
    vi.runOnlyPendingTimers();
    expect(pmNames()).toEqual(["Alice"]);
    expect(storage.closedChats.load()[serverId]).toEqual({});
  });

  it("forgets the close when the user opens the chat again", () => {
    useStore.getState().deletePrivateChat(serverId, "alice-id");
    useStore.getState().openPrivateChat(serverId, "alice");
    expect(storage.closedChats.load()[serverId]).toEqual({});
  });
});
