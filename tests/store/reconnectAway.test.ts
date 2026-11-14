import { beforeEach, describe, expect, it } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

describe("away across a reconnect", () => {
  beforeEach(() => {
    useStore.setState({
      servers: [
        {
          id: "s1",
          host: "irc.example",
          port: 6697,
          isConnected: false,
          isAway: true,
          awayMessage: "gone",
          channels: [],
          privateChats: [],
        } as unknown as Server,
      ],
    });
  });

  it("starts a new connection as present", () => {
    ircClient.triggerEvent("connectionStateChange", {
      serverId: "s1",
      connectionState: "connected",
    });

    const [server] = useStore.getState().servers;
    expect(server.isAway).toBe(false);
    expect(server.awayMessage).toBeUndefined();
  });

  const away = { id: "me", username: "me", isOnline: true, isAway: true };
  const select = (selectedServerId: string) =>
    useStore.setState((state) => ({
      ui: { ...state.ui, selectedServerId },
      currentUser: { ...away, awayMessage: "gone" },
    }));
  const connect = () =>
    ircClient.triggerEvent("connectionStateChange", {
      serverId: "s1",
      connectionState: "connected",
    });

  it("shows the user as present when the selected server reconnects", () => {
    select("s1");
    connect();

    expect(useStore.getState().currentUser?.isAway).toBe(false);
    expect(useStore.getState().currentUser?.awayMessage).toBeUndefined();
  });

  it("leaves the shown user alone when another server reconnects", () => {
    select("other");
    connect();

    expect(useStore.getState().currentUser?.isAway).toBe(true);
  });

  it("keeps the away shown while the connection is only dropped", () => {
    ircClient.triggerEvent("connectionStateChange", {
      serverId: "s1",
      connectionState: "disconnected",
    });

    expect(useStore.getState().servers[0].isAway).toBe(true);
  });
});
