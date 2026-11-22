import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  joinOnFirstReady,
  takeChannelFromAddress,
} from "../../src/lib/channelLink";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { readyProcessedServers } from "../../src/store/handlers/connection";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

const SERVER = "srv-1";

// Mirrors what the app does while it loads: read the address, then join on the first registration.
const joinFromLink = vi.fn((serverId: string, name: string) =>
  useStore.getState().joinChannel(serverId, name),
);

const holdsChannels = (serverId: string) =>
  !useStore.getState().servers.find((s) => s.id === serverId)?.isBouncerControl;

function startWithAddress(address: string) {
  window.history.replaceState({}, "", address);
  const channel = takeChannelFromAddress();
  if (channel) joinOnFirstReady(channel, holdsChannels, joinFromLink);
  return channel;
}

const becomeReady = () =>
  ircClient.triggerEvent("ready", {
    serverId: SERVER,
    serverName: "Test",
    nickname: "me",
  });

describe("opening the app from a link with a channel parameter", () => {
  let sendRaw: ReturnType<typeof vi.spyOn>;
  let joinChannel: ReturnType<typeof vi.spyOn>;
  const joinLines = () =>
    sendRaw.mock.calls
      .map((call: unknown[]) => call[1] as string)
      .filter((line: string) => line.startsWith("JOIN"));
  const savedChannels = () =>
    JSON.parse(lsBacking.get("savedServers") ?? "[]")[0].channels;

  beforeEach(() => {
    joinFromLink.mockClear();
    installLocalStorageBacking();
    lsBacking.set(
      "savedServers",
      JSON.stringify([
        {
          id: SERVER,
          host: "irc.test",
          port: 6667,
          nickname: "me",
          channels: [],
        },
      ]),
    );
    sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    joinChannel = vi.spyOn(ircClient, "joinChannel");
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
    window.history.replaceState({}, "", "/");
  });

  it("joins an encoded channel once and keeps the other parameters", () => {
    startWithAddress("/app?theme=dark&channel=%23weather&lang=de#top");

    expect(window.location.pathname).toBe("/app");
    expect(window.location.search).toBe("?theme=dark&lang=de");
    expect(window.location.hash).toBe("#top");

    becomeReady();

    expect(joinChannel).toHaveBeenCalledTimes(1);
    expect(joinChannel).toHaveBeenCalledWith(SERVER, "#weather", undefined);
    expect(joinLines()).toEqual(["JOIN #weather"]);
    expect(savedChannels()).toEqual(["#weather"]);

    readyProcessedServers.delete(SERVER);
    becomeReady();

    expect(joinFromLink).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["two channels", "%23one%2C%23two"],
    ["a channel and a key", "%23one%20key"],
    ["a channel and a second line", "%23one%0D%0APRIVMSG%20%23two%20%3Atext"],
    ["a channel and the leave-all target", "%23one%2C0"],
  ])("joins nothing for a value holding %s", (_, value) => {
    startWithAddress(`/?channel=${value}&theme=dark`);

    expect(window.location.search).toBe("?theme=dark");

    becomeReady();

    expect(joinChannel).not.toHaveBeenCalled();
    expect(joinLines()).toEqual([]);
    expect(savedChannels()).toEqual([]);
  });

  it("reads no channel from an unencoded #, which starts the fragment", () => {
    expect(startWithAddress("/?channel=#weather")).toBeNull();
    expect(window.location.hash).toBe("#weather");

    becomeReady();

    expect(joinChannel).not.toHaveBeenCalled();
  });

  it("waits past a bouncer's control session for a server that holds channels", () => {
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({ ...s, isBouncerControl: true })),
    }));
    startWithAddress("/?channel=%23weather");

    becomeReady();
    expect(joinFromLink).not.toHaveBeenCalled();

    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({ ...s, isBouncerControl: false })),
    }));
    readyProcessedServers.delete(SERVER);
    becomeReady();
    expect(joinLines()).toEqual(["JOIN #weather"]);
  });

  it("gives a bare name the # prefix", () => {
    startWithAddress("/?channel=weather");
    becomeReady();

    expect(joinLines()).toEqual(["JOIN #weather"]);
  });
});
