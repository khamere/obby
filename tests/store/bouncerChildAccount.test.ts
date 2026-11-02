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
