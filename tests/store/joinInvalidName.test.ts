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

// Reads a line the way a server does: arguments split on spaces, and a colon
// opens a last argument that runs to the end of the line.
function serverArguments(line: string): string[] {
  const trailingAt = line.indexOf(" :");
  if (trailingAt === -1) return line.split(" ");
  return [...line.slice(0, trailingAt).split(" "), line.slice(trailingAt + 2)];
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

  it.each([
    ["a line break", "key\r\nQUIT"],
    ["a space", "key #other"],
    ["a comma", "key,other"],
  ])("sends and saves nothing for a key with %s", (_, key) => {
    useStore.getState().joinChannel(SERVER, "#locked", key);

    expect(sentLines()).toEqual([]);
    expect(channelNames()).toEqual([]);
    expect(savedChannels()).toEqual(["#saved"]);
  });

  it.each([
    ["a name longer than any limit we know", `#${"a".repeat(300)}`],
    ["a name with a non-breaking space", "#two\u00a0words"],
    ["a name outside ASCII", "#日本語"],
  ])("sends %s to the server", (_, name) => {
    useStore.getState().joinChannel(SERVER, name);

    expect(sentLines()).toContain(`JOIN ${name}`);
    expect(savedChannels()).toEqual(["#saved", name]);
  });

  it("still joins a plain channel, with and without a key", () => {
    useStore.getState().joinChannel(SERVER, "#open");
    useStore.getState().joinChannel(SERVER, "locked", "secret");

    expect(sentLines()).toContain("JOIN #open");
    expect(sentLines()).toContain("JOIN #locked secret");
    expect(channelNames()).toEqual(["#open", "#locked"]);
  });

  it("keeps every saved name the server can judge when it connects", () => {
    const saved = [
      "#saved",
      `#${"a".repeat(200)}`,
      "#two\u00a0words",
      "#café",
      "#tab\there",
    ];
    saveChannels(saved);

    ircClient.triggerEvent("ready", {
      serverId: SERVER,
      serverName: "Test",
      nickname: "me",
    });

    expect(savedChannels()).toEqual(saved);
    expect(
      sentLines().filter((line: string) => line.startsWith("JOIN")),
    ).toEqual(saved.map((name) => `JOIN ${name}`));
  });

  it.each([":secret", "::", ":", "se:cret", "secret"])(
    "sends the key %j so the server reads it as typed",
    (key) => {
      useStore.getState().joinChannel(SERVER, "#vault", key);

      const joins = sentLines().filter((line: string) =>
        line.startsWith("JOIN"),
      );
      expect(joins.map(serverArguments)).toEqual([["JOIN", "#vault", key]]);
    },
  );

  it("rejoins the saved channels when the saved list holds an entry that is no name", () => {
    lsBacking.set(
      "savedServers",
      JSON.stringify([
        {
          id: SERVER,
          host: "irc.test",
          port: 6667,
          nickname: "me",
          channels: ["#saved", null, 7, { name: "#x" }, "#other"],
        },
      ]),
    );

    ircClient.triggerEvent("ready", {
      serverId: SERVER,
      serverName: "Test",
      nickname: "me",
    });

    expect(
      sentLines().filter((line: string) => line.startsWith("JOIN")),
    ).toEqual(["JOIN #saved", "JOIN #other"]);
    expect(savedChannels()).toEqual(["#saved", "#other"]);
  });

  it("joins and leaves a channel while the saved list holds an entry that is no name", () => {
    lsBacking.set(
      "savedServers",
      JSON.stringify([
        {
          id: SERVER,
          host: "irc.test",
          port: 6667,
          nickname: "me",
          channels: ["#saved", null],
        },
      ]),
    );

    useStore.getState().joinChannel(SERVER, "#open");
    expect(savedChannels()).toContain("#open");

    useStore.getState().forgetChannel(SERVER, "#open");
    expect(savedChannels()).toEqual(["#saved"]);
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

  it("drops such a saved name in a bouncer session too", () => {
    saveChannels(["#saved", INJECTED, "#a,0"]);
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        bouncerNetid: "1",
      })),
    }));

    ircClient.triggerEvent("ready", {
      serverId: SERVER,
      serverName: "Test",
      nickname: "me",
    });

    expect(
      sentLines().filter((line: string) => line.startsWith("JOIN")),
    ).toEqual([]);
    expect(savedChannels()).toEqual(["#saved"]);
  });
});
