import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { readyProcessedServers } from "../../src/store/handlers/connection";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

const SERVER = "srv-1";
const INJECTED = "#x\r\nPRIVMSG #saved :text";

const channelNames = () =>
  useStore.getState().servers[0].channels.map((c) => c.name);
const savedChannels = () =>
  JSON.parse(lsBacking.get("savedServers") ?? "[]")[0].channels;

function saveChannels(channels: string[]) {
  lsBacking.set(
    "savedServers",
    JSON.stringify([
      { id: SERVER, host: "irc.test", port: 6667, nickname: "me", channels },
    ]),
  );
}

describe("joining a name that is not one channel", () => {
  let sendRaw: ReturnType<typeof vi.spyOn>;
  const sentLines = () =>
    sendRaw.mock.calls.map((call: unknown[]) => call[1] as string);

  beforeEach(() => {
    installLocalStorageBacking();
    saveChannels(["#saved"]);
    sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.set(
      SERVER,
      { id: SERVER, channels: [], capabilities: [] },
    );
    useStore.setState({
      servers: [
        {
          id: SERVER,
          name: "Test",
          host: "irc.test",
          port: 6667,
          channels: [],
          privateChats: [],
          users: [],
          isConnected: true,
        },
      ],
      channelOrder: {},
    } as Partial<AppState>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    readyProcessedServers.delete(SERVER);
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.delete(
      SERVER,
    );
  });

  it.each([
    ["a line break", INJECTED],
    ["a space", "#a key"],
    ["a comma", "#a,0"],
    ["a bare name with a space", "a b"],
  ])("sends and saves nothing for a name with %s", (_, name) => {
    useStore.getState().joinChannel(SERVER, name);

    expect(sentLines()).toEqual([]);
    expect(channelNames()).toEqual([]);
    expect(savedChannels()).toEqual(["#saved"]);
    expect(useStore.getState().channelOrder[SERVER]).toBeUndefined();
  });

  it("sends nothing for a key with a line break", () => {
    useStore.getState().joinChannel(SERVER, "#locked", "key\r\nQUIT");

    expect(sentLines()).toEqual([]);
    expect(channelNames()).toEqual([]);
  });

  it("still joins a plain channel, with and without a key", () => {
    useStore.getState().joinChannel(SERVER, "#open");
    useStore.getState().joinChannel(SERVER, "locked", "secret");

    expect(sentLines()).toContain("JOIN #open");
    expect(sentLines()).toContain("JOIN #locked secret");
    expect(channelNames()).toEqual(["#open", "#locked"]);
  });

  it("drops such a saved name on connect and rejoins the others", () => {
    saveChannels(["#saved", INJECTED, "#a b"]);

    ircClient.triggerEvent("ready", {
      serverId: SERVER,
      serverName: "Test",
      nickname: "me",
    });

    const joins = sentLines().filter((line: string) => line.startsWith("JOIN"));
    expect(joins).toEqual(["JOIN #saved"]);
    expect(channelNames()).toEqual(["#saved"]);
    expect(savedChannels()).toEqual(["#saved"]);
  });
});
