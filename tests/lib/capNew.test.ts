import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

// soju only offers some caps once a connection is bound to a network, so a
// bouncer child (which negotiates before BOUNCER BIND) learns of them through
// CAP NEW. draft/event-playback is one: without it soju's history replays skip
// every message without text, so reactions disappear after a reload.
const serverId = "capnew-srv";

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

function seed(capabilities: string[]) {
  const server = {
    id: serverId,
    name: "s",
    host: "soju.example",
    port: 443,
    channels: [],
    privateChats: [],
    users: [],
    isConnected: true,
    capabilities: [...capabilities],
  } as Server;
  ircClient.servers.set(serverId, { ...server });
  useStore.setState({ servers: [server] } as unknown as Partial<AppState>);
}

describe("CAP NEW", () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_id, line) => {
      sent.push(line);
    });
    ircClient.capNegotiationComplete.set(serverId, true);
  });
  afterEach(() => {
    ircClient.servers.delete(serverId);
    ircClient.capNegotiationComplete.delete(serverId);
    vi.restoreAllMocks();
  });

  it("requests a newly offered cap we want, and enables it on ACK", () => {
    seed(["batch", "draft/chathistory"]);
    feed(":soju.example CAP me NEW draft/event-playback");
    expect(sent).toEqual(["CAP REQ :draft/event-playback"]);

    feed(":soju.example CAP me ACK draft/event-playback");
    expect(ircClient.hasCapability(serverId, "draft/event-playback")).toBe(
      true,
    );
    expect(
      useStore.getState().servers.find((s) => s.id === serverId)?.capabilities,
    ).toContain("draft/event-playback");
  });

  it("doesn't request unknown, already-enabled or sasl caps", () => {
    seed(["batch"]);
    feed(":soju.example CAP me NEW :batch some-vendor/thing sasl=PLAIN");
    expect(sent).toEqual([]);
  });

  it("requests several wanted caps in one line and keeps their values", () => {
    seed([]);
    feed(
      ":soju.example CAP me NEW :draft/event-playback draft/multiline=max-bytes=4096",
    );
    expect(sent).toEqual(["CAP REQ :draft/event-playback draft/multiline"]);
    expect(
      ircClient.servers.get(serverId)?.capabilityValues?.["draft/multiline"],
    ).toBe("max-bytes=4096");
  });
});
