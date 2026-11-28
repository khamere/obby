import { beforeEach, describe, expect, it } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";

const serverId = "s1";
const whois = () => useStore.getState().whoisData[serverId];

describe("the end of a WHOIS reply", () => {
  beforeEach(() => {
    useStore.setState({ whoisData: {} });
  });

  it("completes the entry the server stored in its own spelling of the nick", () => {
    ircClient.triggerEvent("WHOIS_USER", {
      serverId,
      nick: "Alice",
      username: "al",
      host: "host.example",
      realname: "Alice",
    });

    ircClient.triggerEvent("WHOIS_END", { serverId, nick: "alice" });

    expect(Object.keys(whois())).toEqual(["Alice"]);
    expect(whois().Alice).toMatchObject({ username: "al", isComplete: true });
  });

  it("stores nothing for a nick the server knows nothing about", () => {
    ircClient.triggerEvent("WHOIS_END", { serverId, nick: "nobody" });

    expect(whois()).toBeUndefined();
  });
});
