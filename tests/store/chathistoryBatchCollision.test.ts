import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import {
  chathistoryBuffers,
  reactionBuffers,
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
    ircClient.nicks.set("mns", "me");
    ircClient.nicks.set("aither", "me");
    chathistoryBuffers.clear();
    reactionBuffers.clear();
    useStore.setState({
      servers: [server("mns"), server("aither")],
      messages: {},
      activeBatches: {},
      processedMessageIds: new Set(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete("mns");
    ircClient.nicks.delete("aither");
    ircClient.activeBatches.delete("mns");
    ircClient.activeBatches.delete("aither");
  });

  it("keeps each network's replay in its own channel", () => {
    feed("mns", ":soju BATCH +6 chathistory #lounge");
    feed("aither", ":soju BATCH +6 chathistory #lounge");
    feed(
      "mns",
      "@batch=6;time=2026-10-14T09:26:00Z;msgid=m1 :dilligaf!u@h PRIVMSG #lounge :not sure lol",
    );
    feed(
      "aither",
      "@batch=6;time=2026-10-14T09:20:00Z;msgid=a1 :Chatbot!u@h PRIVMSG #lounge :[stannaz] does the stats page not work",
    );
    feed("mns", ":soju BATCH -6");
    feed("aither", ":soju BATCH -6");

    expect(contents("mns")).toEqual(["not sure lol"]);
    expect(contents("aither")).toEqual([
      "[stannaz] does the stats page not work",
    ]);
  });
});
