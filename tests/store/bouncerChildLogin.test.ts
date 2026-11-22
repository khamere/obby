import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import * as storage from "../../src/store/localStorage";

const bouncerId = "srv-bouncer";
const networkId = "srv-bouncer-net";

const plain = (user: string, pass: string) =>
  `AUTHENTICATE ${btoa(`${user}\x00${user}\x00${pass}`)}`;

describe("a bouncer network logging in", () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
    ircClient.capNegotiationComplete.delete(networkId);
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_id, line) => {
      sent.push(line);
    });
    vi.spyOn(ircClient, "getSaslMechanisms").mockReturnValue(["PLAIN"]);
    vi.spyOn(ircClient, "getConnectTarget").mockReturnValue({
      host: "wss://bouncer.example.com",
      port: 443,
    });
    const login = {
      host: "wss://bouncer.example.com",
      port: 443,
      nickname: "me",
      channels: [],
      saslEnabled: true,
      saslAccountName: "me",
    };
    vi.spyOn(storage.servers, "load").mockReturnValue([
      {
        ...login,
        id: bouncerId,
        isBouncerControl: true,
        saslPassword: btoa("new-pass"),
      },
      {
        ...login,
        id: networkId,
        bouncerServerId: bouncerId,
        bouncerNetid: "1",
        saslPassword: btoa("old-pass"),
      },
    ]);
    useStore.setState({ servers: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("sends the password saved on its bouncer, whatever its own row holds", () => {
    ircClient.triggerEvent("CAP_ACKNOWLEDGED", {
      serverId: networkId,
      key: "sasl",
      capabilities: "sasl",
    });
    ircClient.triggerEvent("AUTHENTICATE", { serverId: networkId, param: "+" });

    expect(sent).toEqual(["AUTHENTICATE PLAIN", plain("me", "new-pass")]);
  });

  test("the bouncer itself sends its own saved password", () => {
    ircClient.triggerEvent("CAP_ACKNOWLEDGED", {
      serverId: bouncerId,
      key: "sasl",
      capabilities: "sasl",
    });
    ircClient.triggerEvent("AUTHENTICATE", { serverId: bouncerId, param: "+" });

    expect(sent).toEqual(["AUTHENTICATE PLAIN", plain("me", "new-pass")]);
  });

  test("sends no login on a connection to an address its bouncer has left", () => {
    vi.spyOn(ircClient, "getConnectTarget").mockReturnValue({
      host: "wss://old.example.com",
      port: 443,
    });
    const setSaslEnabled = vi.spyOn(ircClient, "setSaslEnabled");
    ircClient.triggerEvent("CAP_ACKNOWLEDGED", {
      serverId: networkId,
      key: "sasl",
      capabilities: "sasl",
    });
    ircClient.triggerEvent("AUTHENTICATE", { serverId: networkId, param: "+" });

    expect(sent).toEqual([]);
    expect(setSaslEnabled).toHaveBeenCalledWith(networkId, false);
  });

  test("tells the client it holds no login once the saved one is removed", () => {
    vi.spyOn(storage.servers, "load").mockReturnValue([
      {
        id: bouncerId,
        host: "wss://bouncer.example.com",
        port: 443,
        nickname: "me",
        channels: [],
        saslEnabled: false,
      },
    ]);
    const setSaslEnabled = vi.spyOn(ircClient, "setSaslEnabled");
    ircClient.triggerEvent("CAP_ACKNOWLEDGED", {
      serverId: bouncerId,
      key: "sasl",
      capabilities: "sasl",
    });

    expect(sent).toEqual([]);
    expect(setSaslEnabled).toHaveBeenCalledWith(bouncerId, false);
  });
});

describe("a bouncer moved to another address", () => {
  const saved = (host: string) => [
    {
      id: bouncerId,
      host,
      port: 443,
      nickname: "me",
      channels: [],
      isBouncerControl: true,
    },
  ];

  beforeEach(() => {
    let stored = JSON.stringify(saved("wss://bouncer.example.com"));
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === "savedServers" ? stored : null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      if (key === "savedServers") stored = value;
    });
    vi.spyOn(ircClient, "getConnectTarget").mockReturnValue({
      host: "wss://bouncer.example.com",
      port: 443,
    });
    useStore.setState({
      servers: [
        {
          id: networkId,
          name: "net",
          host: "bouncer.example.com",
          port: 443,
          channels: [],
          privateChats: [],
          users: [],
          isConnected: false,
          connectionState: "reconnecting",
          bouncerServerId: bouncerId,
          bouncerNetid: "1",
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ servers: [] });
  });

  test("closes its networks' connections and retries to the old address", () => {
    const disconnect = vi
      .spyOn(ircClient, "disconnect")
      .mockImplementation(() => {});
    useStore
      .getState()
      .updateServer(bouncerId, { host: "wss://new.example.com", port: 443 });

    expect(disconnect).toHaveBeenCalledWith(networkId);
  });

  test("leaves its networks alone when the address stays", () => {
    const disconnect = vi
      .spyOn(ircClient, "disconnect")
      .mockImplementation(() => {});
    useStore.getState().updateServer(bouncerId, {
      host: "wss://bouncer.example.com",
      port: 443,
      nickname: "other",
    });

    expect(disconnect).not.toHaveBeenCalled();
  });
});
