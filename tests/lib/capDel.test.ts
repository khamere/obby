import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { shouldUseLabeledResponse } from "../../src/lib/labeledResponse";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

// soju negotiates caps before BOUNCER BIND with every passthrough cap on
// offer, then CAP DELs the ones the bound network lacks. A network without
// labeled-response (e.g. one that only offers away-notify/extended-join/
// account-notify/sasl) must stop getting labelled sends, or every own
// message shows twice and its placeholder ends up "failed".
const serverId = "capdel-srv";

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

function seed(capabilities: string[], capabilityValues = {}) {
  const server: Server = {
    id: serverId,
    name: "s",
    host: "soju.example",
    port: 443,
    channels: [],
    privateChats: [],
    users: [],
    isConnected: true,
    capabilities: [...capabilities],
    capabilityValues,
  } as Server;
  ircClient.servers.set(serverId, { ...server });
  useStore.setState({ servers: [server] } as unknown as Partial<AppState>);
}

function storeCaps() {
  return useStore.getState().servers.find((s) => s.id === serverId)
    ?.capabilities;
}

describe("CAP DEL", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
  });
  afterEach(() => {
    ircClient.servers.delete(serverId);
    vi.restoreAllMocks();
  });

  it("withdrawn caps are no longer reported as enabled", () => {
    seed(["batch", "echo-message", "labeled-response", "message-tags"]);
    expect(shouldUseLabeledResponse(serverId)).toBe(true);

    feed(":soju.example CAP me DEL labeled-response");
    feed(":soju.example CAP me DEL message-tags");

    expect(ircClient.hasCapability(serverId, "labeled-response")).toBe(false);
    expect(ircClient.hasCapability(serverId, "message-tags")).toBe(false);
    expect(ircClient.hasCapability(serverId, "echo-message")).toBe(true);
    expect(shouldUseLabeledResponse(serverId)).toBe(false);
  });

  it("the store's copy of the caps is updated too", () => {
    seed(["batch", "labeled-response", "draft/chathistory"]);
    feed(":soju.example CAP me DEL :labeled-response draft/chathistory");
    expect(storeCaps()).toEqual(["batch"]);
  });

  it("drops a withdrawn cap's value and ignores unknown names", () => {
    seed(["draft/multiline", "batch"], {
      "draft/multiline": "max-bytes=4096",
    });
    feed(":soju.example CAP me DEL :draft/multiline not-a-cap");
    expect(
      ircClient.servers.get(serverId)?.capabilityValues?.["draft/multiline"],
    ).toBeUndefined();
    expect(ircClient.hasCapability(serverId, "batch")).toBe(true);
  });
});
