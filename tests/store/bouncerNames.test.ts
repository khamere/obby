import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { serverDisplayName } from "../../src/lib/serverDisplayName";
import useStore from "../../src/store";
import { readyProcessedServers } from "../../src/store/handlers/connection";
import { generateDeterministicId } from "../../src/store/helpers";
import * as storage from "../../src/store/localStorage";
import type { Server, ServerConfig } from "../../src/types";

const parent: Server = {
  id: "names-parent",
  name: "soju",
  host: "soju.example",
  port: 443,
  channels: [],
  privateChats: [],
  users: [],
  isConnected: true,
};
const child: Server = {
  ...parent,
  id: generateDeterministicId(parent.id, "42"),
  name: "soju/42",
  networkName: "Nether.RIP",
  bouncerServerId: parent.id,
  bouncerNetid: "42",
};
const config: ServerConfig = {
  id: child.id,
  name: child.name,
  host: child.host,
  port: child.port,
  nickname: "alice",
  saslEnabled: true,
  saslPassword: "test-secret",
  channels: ["#test"],
  bouncerServerId: parent.id,
  bouncerNetid: "42",
};

function announce(
  attributes: Record<string, string>,
  serverId = parent.id,
  deleted = false,
) {
  ircClient.triggerEvent("BOUNCER_NETWORK", {
    serverId,
    netid: "42",
    attributes,
    deleted,
  });
}

describe("soju child names", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation(
      (key) => backing.get(key) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      backing.set(key, value);
    });
    storage.servers.save([config]);
    useStore.setState({ servers: [parent, child], bouncers: {} });
  });
  afterEach(() => {
    readyProcessedServers.delete(child.id);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useStore.setState({ servers: [], bouncers: {} });
  });
  test("initial names and later renames update the child and survive storage reload", () => {
    for (const name of ["upload.cx", "My Tracker"]) {
      announce({ name });
      expect(
        useStore.getState().servers.find((s) => s.id === child.id)?.name,
      ).toBe(name);
      expect(storage.servers.load()).toEqual([{ ...config, name }]);
    }
  });
  test("a saved child is renamed even before its live connection is restored", () => {
    useStore.setState({ servers: [parent] });
    announce({ name: "Restored name" });
    expect(storage.servers.load()[0].name).toBe("Restored name");
    expect(useStore.getState().servers).toEqual([parent]);
  });
  test("partial updates preserve names and empty names use the upstream fallback", () => {
    announce({ name: "upload.cx" });
    announce({ host: "irc.example" });
    expect(storage.servers.load()[0].name).toBe("upload.cx");
    announce({ name: "" });
    const state = useStore.getState();
    const live = state.servers.find((s) => s.id === child.id);
    if (!live) throw new Error("Missing bound child");
    expect(
      serverDisplayName(live, state.bouncers[parent.id].networks["42"]),
    ).toBe("Nether.RIP");
    expect(storage.servers.load()[0].name).toBe("upload.cx");
  });
  test("child announcements cannot rename a nested row or its saved config", () => {
    const nested = { ...child, id: generateDeterministicId(child.id, "42") };
    useStore.setState({ servers: [parent, child, nested] });
    storage.servers.save([{ ...config, id: nested.id }]);
    announce({ name: "Wrong name" }, child.id);
    expect(useStore.getState().servers.find((s) => s.id === nested.id)).toEqual(
      nested,
    );
    expect(storage.servers.load()[0].name).toBe(config.name);
  });
  test("deleted announcements never persist a rename", () => {
    useStore.setState({ servers: [parent] });
    announce({ name: "Deleted name" }, parent.id, true);
    expect(storage.servers.load()[0]).toEqual(config);
  });
  test("an unrelated upstream NETWORK update does not replace the soju name", () => {
    announce({ name: "upload.cx" });
    ircClient.triggerEvent("ISUPPORT", {
      serverId: child.id,
      key: "NETWORK",
      value: "Other upstream",
    });
    const state = useStore.getState();
    const live = state.servers.find((s) => s.id === child.id);
    if (!live) throw new Error("Missing bound child");
    expect(
      serverDisplayName(live, state.bouncers[parent.id].networks["42"]),
    ).toBe("upload.cx");
  });
  test("connection readiness does not overwrite a name received during connection setup", () => {
    vi.useFakeTimers();
    announce({ name: "upload.cx" });
    readyProcessedServers.delete(child.id);
    ircClient.triggerEvent("ready", {
      serverId: child.id,
      serverName: "soju/42",
      nickname: "alice",
    });
    expect(
      useStore.getState().servers.find((s) => s.id === child.id)?.name,
    ).toBe("upload.cx");
    vi.clearAllTimers();
  });
});
