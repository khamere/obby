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
});
