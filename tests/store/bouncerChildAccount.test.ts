import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import { registerAuthHandlers } from "../../src/store/handlers/auth";
import { serverTracksReadMarker } from "../../src/store/helpers";

// A network bound through a bouncer logs in as the bouncer's account; the
// bouncer answers a 900 on that connection only when the upstream is logged
// in, so the child takes the account from the control connection, and its
// read markers go to the bouncer.
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
    ircClient.triggerEvent("CAP ACK", {
      serverId,
      cliCaps: "draft/read-marker",
    });
  };
  const logIn = (serverId: string) =>
    ircClient.triggerEvent("LOGGED_IN", { serverId, account: "me" });
  const server = (id: string) =>
    useStore.getState().servers.find((s) => s.id === id);

  beforeEach(() => {
    const row = {
      host: "bouncer.example",
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
        { ...row, id: "parent", name: "bouncer", isBouncerControl: true },
        {
          ...row,
          id: "child",
          name: "network",
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
    expect(server("child")?.account).toBe("me");
    expect(serverTracksReadMarker(useStore.getState(), "child")).toBe(true);
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
    expect(server("child")?.account).toBe("me");
    ircClient.triggerEvent("LOGGED_OUT", { serverId: "parent" });

    expect(server("child")?.account).toBeUndefined();
  });

  it("leaves a server of its own without an account until it logs in again", () => {
    drop("plain");
    open("plain");

    expect(server("plain")?.account).toBeUndefined();
  });

  it("stays while the control connection is down too", () => {
    drop("parent");
    drop("child");
    open("child");

    expect(server("child")?.account).toBe("me");
    expect(serverTracksReadMarker(useStore.getState(), "child")).toBe(true);
  });

  it("drops the upstream account the bouncer named on the last connection", () => {
    ircClient.triggerEvent("LOGGED_IN", {
      serverId: "child",
      account: "upstream",
    });
    expect(server("child")?.account).toBe("upstream");

    drop("child");
    open("child");

    expect(server("child")?.account).toBe("me");
  });

  it("drops the upstream account when the control connection went first", () => {
    ircClient.triggerEvent("LOGGED_IN", {
      serverId: "child",
      account: "upstream",
    });

    drop("parent");
    drop("child");
    open("child");

    expect(server("child")?.account).toBe("me");
  });

  describe("with a private chat", () => {
    const welcome = (time: string) =>
      ircClient.triggerEvent("parsedLine", {
        serverId: "child",
        line: ":bouncer.example 001 me :Welcome",
        command: "001",
        source: "bouncer.example",
        parv: ["me", "Welcome"],
        mtags: { time },
      });
    const seedChat = (marker: {
      readMarker?: string | null;
      readMarkerFetched?: boolean;
    }) =>
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
                    ...marker,
                  },
                ],
              }
            : row,
        ),
      }));
    const chat = () => server("child")?.privateChats?.[0];
    let markreadGet: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.spyOn(ircClient, "getNick").mockReturnValue("me");
      markreadGet = vi
        .spyOn(ircClient, "markreadGet")
        .mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      useStore.setState({ messages: {} });
    });

    it("keeps a line nobody read unread", () => {
      welcome("2026-01-02T00:00:00.000Z");
      seedChat({ readMarker: null, readMarkerFetched: true });
      useStore.setState({
        messages: {
          "child-pm": [
            {
              id: "m1",
              msgid: "m1",
              type: "message",
              content: "hello",
              timestamp: new Date("2026-01-01T00:00:00.000Z"),
              userId: "friend",
              channelId: "pm",
              serverId: "child",
              reactions: [],
              replyMessage: null,
              mentioned: [],
            },
          ],
        },
      } as never);
      expect(chat()?.unreadCount).toBe(1);

      drop("child");
      open("child");
      welcome("2026-01-03T00:00:00.000Z");

      expect(chat()?.readMarker).toBeNull();
      expect(chat()).toMatchObject({ unreadCount: 1, isMentioned: true });
    });

    it("asks again for a marker whose answer the last connection lost", () => {
      welcome("2026-01-02T00:00:00.000Z");
      seedChat({ readMarkerFetched: true });

      drop("child");
      open("child");
      expect(markreadGet).not.toHaveBeenCalled();
      welcome("2026-01-03T00:00:00.000Z");

      expect(markreadGet.mock.calls).toEqual([["child", "friend"]]);
    });

    it("asks for every private chat once, however many there are", () => {
      welcome("2026-01-02T00:00:00.000Z");
      const names = Array.from({ length: 3000 }, (_, i) => `friend${i}`);
      useStore.setState((s) => ({
        servers: s.servers.map((row) =>
          row.id === "child"
            ? {
                ...row,
                privateChats: names.map((username) => ({
                  id: `pm-${username}`,
                  username,
                  serverId: "child",
                  unreadCount: 0,
                  isMentioned: false,
                  readMarker: null,
                  readMarkerFetched: true,
                })),
              }
            : row,
        ),
      }));

      drop("child");
      open("child");
      welcome("2026-01-03T00:00:00.000Z");

      expect(markreadGet.mock.calls).toEqual(
        names.map((name) => ["child", name]),
      );
    });

    it("asks again for a marker it knows, since another client can have moved it", () => {
      welcome("2026-01-02T00:00:00.000Z");
      seedChat({
        readMarker: "2026-01-01T00:00:00.000Z",
        readMarkerFetched: true,
      });

      drop("child");
      open("child");
      welcome("2026-01-03T00:00:00.000Z");
      ircClient.triggerEvent("MARKREAD", {
        serverId: "child",
        target: "friend",
        timestamp: "2026-01-02T12:00:00.000Z",
      } as never);

      expect(markreadGet.mock.calls).toEqual([["child", "friend"]]);
      expect(chat()?.readMarker).toBe("2026-01-02T12:00:00.000Z");
    });
  });
});
