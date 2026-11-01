import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import {
  chathistoryBuffers,
  historyEditBuffers,
} from "../../src/store/handlers/batches";
import type { Server } from "../../src/types";

// A soju bouncer numbers batches per downstream connection, so two
// network children replaying history at the same time (e.g. after a
// laptop wakes up) can both be inside a batch called "6".

function feed(serverId: string, ...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

const server = (id: string): Server =>
  ({
    id,
    name: id,
    host: "bouncer.test",
    port: 6697,
    isConnected: true,
    users: [],
    privateChats: [],
    capabilities: ["draft/chathistory"],
    channels: [
      {
        id: `${id}-lounge`,
        name: "#lounge",
        serverId: id,
        users: [],
        messages: [],
        unreadCount: 0,
        isMentioned: false,
        isPrivate: false,
      },
    ],
  }) as unknown as Server;

const contents = (id: string) =>
  (useStore.getState().messages[`${id}-${id}-lounge`] ?? []).map(
    (m) => m.content,
  );

describe("chathistory batches with the same id on different servers", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    ircClient.nicks.set("netA", "me");
    ircClient.nicks.set("netB", "me");
    chathistoryBuffers.clear();
    historyEditBuffers.clear();
    useStore.setState({
      servers: [server("netA"), server("netB")],
      messages: {},
      activeBatches: {},
      processedMessageIds: new Set(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete("netA");
    ircClient.nicks.delete("netB");
    ircClient.activeBatches.delete("netA");
    ircClient.activeBatches.delete("netB");
  });

  it("keeps each network's replay in its own channel", () => {
    feed("netA", ":soju BATCH +6 chathistory #lounge");
    feed("netB", ":soju BATCH +6 chathistory #lounge");
    feed(
      "netA",
      "@batch=6;time=2026-01-02T10:01:00Z;msgid=m1 :quill!u@h PRIVMSG #lounge :first network line",
    );
    feed(
      "netB",
      "@batch=6;time=2026-01-02T10:00:00Z;msgid=a1 :RelayBot!u@h PRIVMSG #lounge :[tamsin] second network line",
    );
    feed("netA", ":soju BATCH -6");
    feed("netB", ":soju BATCH -6");

    expect(contents("netA")).toEqual(["first network line"]);
    expect(contents("netB")).toEqual([
      "[tamsin] second network line",
    ]);
  });
});
