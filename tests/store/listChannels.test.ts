import { beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

const serverId = "srv-list";

function setServer(isRegistered: boolean) {
  const server: Server = {
    id: serverId,
    name: "s",
    host: "irc.example.com",
    port: 443,
    channels: [],
    privateChats: [],
    isConnected: true,
    isRegistered,
    users: [],
  };
  useStore.setState({ servers: [server], listingInProgress: {} });
}

describe("listChannels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("waits for registration so the list never hangs on a LIST the server ignored", () => {
    const list = vi
      .spyOn(ircClient, "listChannels")
      .mockImplementation(() => {});
    setServer(false);

    useStore.getState().listChannels(serverId);

    expect(list).not.toHaveBeenCalled();
    expect(useStore.getState().listingInProgress[serverId]).toBeUndefined();
  });

  test("sends LIST once the server registered us", () => {
    const list = vi
      .spyOn(ircClient, "listChannels")
      .mockImplementation(() => {});
    setServer(true);

    useStore.getState().listChannels(serverId);

    expect(list).toHaveBeenCalled();
    expect(useStore.getState().listingInProgress[serverId]).toBe(true);
  });
});

describe("the end of a channel list", () => {
  const lounge = { channel: "#lounge", userCount: 3, topic: "" };
  const help = { channel: "#help", userCount: 1, topic: "" };

  test("keeps the list we hold when we asked for none", () => {
    useStore.setState({
      channelList: { [serverId]: [lounge, help] },
      channelListBuffer: { [serverId]: [] },
      listingInProgress: { [serverId]: false },
    });

    ircClient.triggerEvent("LIST_END", { serverId });

    expect(useStore.getState().channelList[serverId]).toEqual([lounge, help]);
  });

  test("shows the channels that arrived for the list we asked for", () => {
    useStore.setState({
      channelList: { [serverId]: [] },
      channelListBuffer: { [serverId]: [lounge] },
      listingInProgress: { [serverId]: true },
    });

    ircClient.triggerEvent("LIST_END", { serverId });

    const state = useStore.getState();
    expect(state.channelList[serverId]).toEqual([lounge]);
    expect(state.channelListBuffer[serverId]).toEqual([]);
    expect(state.listingInProgress[serverId]).toBe(false);
  });
});
