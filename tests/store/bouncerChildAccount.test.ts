import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import { registerAuthHandlers } from "../../src/store/handlers/auth";
import { serverTracksReadMarker } from "../../src/store/helpers";

// A network bound through a bouncer logs in as the bouncer's account; the
// bouncer answers no 900 on that connection, so the child takes the account
// from the control connection, and its read markers go to the bouncer.
describe("a bouncer child's account", () => {
  let saved: Record<string, unknown[]>;

  beforeEach(() => {
    const c = ircClient as unknown as {
      eventCallbacks: Record<string, unknown[]>;
    };
    saved = c.eventCallbacks;
    c.eventCallbacks = {};
    registerAuthHandlers(useStore);
    useStore.setState({
      servers: [
        {
          id: "parent",
          name: "soju",
          host: "soju.example",
          port: 6697,
          isConnected: true,
          isBouncerControl: true,
          capabilities: ["draft/read-marker"],
          channels: [],
          privateChats: [],
          users: [],
        },
        {
          id: "child",
          name: "Libera",
          host: "soju.example",
          port: 6697,
          isConnected: true,
          bouncerServerId: "parent",
          bouncerNetid: "1",
          capabilities: ["draft/read-marker"],
          channels: [],
          privateChats: [],
          users: [],
        },
      ],
    } as never);
  });

  afterEach(() => {
    (
      ircClient as unknown as { eventCallbacks: Record<string, unknown[]> }
    ).eventCallbacks = saved;
  });

  it("follows the control connection's login", () => {
    expect(serverTracksReadMarker(useStore.getState(), "child")).toBe(false);
    ircClient.triggerEvent("LOGGED_IN", { serverId: "parent", account: "me" });
    const child = useStore.getState().servers.find((s) => s.id === "child");
    expect(child?.account).toBe("me");
    expect(serverTracksReadMarker(useStore.getState(), "child")).toBe(true);
  });
});

describe("a bouncer child's account across a reconnect", () => {
  const state = (serverId: string, connectionState: string) =>
    ircClient.triggerEvent("connectionStateChange", {
      serverId,
      connectionState,
    } as never);
  const drop = (serverId: string) => {
    state(serverId, "disconnected");
    state(serverId, "reconnecting");
  };
  const open = (serverId: string) => {
    state(serverId, "connecting");
    state(serverId, "connected");
  };
  const logIn = (serverId: string) =>
    ircClient.triggerEvent("LOGGED_IN", { serverId, account: "me" });
  const server = (id: string) =>
    useStore.getState().servers.find((s) => s.id === id);

  beforeEach(() => {
    const row = {
      host: "soju.example",
      port: 6697,
      isConnected: true,
      connectionState: "connected",
      capabilities: ["draft/read-marker"],
      channels: [],
      privateChats: [],
      users: [],
    };
    useStore.setState({
      servers: [
        { ...row, id: "parent", name: "soju", isBouncerControl: true },
        {
          ...row,
          id: "child",
          name: "Libera",
          bouncerServerId: "parent",
          bouncerNetid: "1",
        },
        { ...row, id: "plain", name: "plain", host: "irc.example" },
      ],
    } as never);
    logIn("parent");
    logIn("plain");
  });

  it("stays when only the child's connection drops and returns", () => {
    drop("child");
    open("child");

    expect(server("child")?.account).toBe("me");
    expect(serverTracksReadMarker(useStore.getState(), "child")).toBe(true);
  });

  it("is back when the control connection logs in before the child returns", () => {
    drop("parent");
    drop("child");
    open("parent");
    logIn("parent");
    open("child");

    expect(server("parent")?.account).toBe("me");
    expect(server("child")?.account).toBe("me");
  });

  it("is back when the child returns before the control connection logs in", () => {
    drop("child");
    drop("parent");
    open("child");
    open("parent");
    logIn("parent");

    expect(server("parent")?.account).toBe("me");
    expect(server("child")?.account).toBe("me");
  });

  it("is back when the control connection logs in between the child's steps", () => {
    drop("parent");
    drop("child");
    state("child", "connecting");
    open("parent");
    logIn("parent");
    state("child", "connected");

    expect(server("child")?.account).toBe("me");
  });

  it("ends when the control connection logs out", () => {
    drop("child");
    open("child");
    ircClient.triggerEvent("LOGGED_OUT", { serverId: "parent" });

    expect(server("child")?.account).toBeUndefined();
  });

  it("leaves a server of its own without an account until it logs in again", () => {
    drop("plain");
    open("plain");

    expect(server("plain")?.account).toBeUndefined();
  });

  it("keeps a private chat nobody read unread", () => {
    useStore.setState((s) => ({
      servers: s.servers.map((row) =>
        row.id === "child"
          ? {
              ...row,
              privateChats: [
                {
                  id: "pm",
                  username: "friend",
                  serverId: "child",
                  unreadCount: 0,
                  isMentioned: false,
                  readMarker: null,
                  readMarkerFetched: true,
                },
              ],
            }
          : row,
      ),
    }));
    ircClient.triggerEvent("parsedLine", {
      serverId: "child",
      line: ":soju.example 001 me :Welcome",
      command: "001",
      source: "soju.example",
      parv: ["me", "Welcome"],
      mtags: { time: "2026-01-01T00:00:00.000Z" },
    });

    drop("child");
    open("child");

    expect(server("child")?.privateChats?.[0].readMarker).toBeNull();
  });
});
