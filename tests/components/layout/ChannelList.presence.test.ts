import { describe, expect, test } from "vitest";
import { presenceOf } from "../../../src/components/layout/ChannelList";
import type { Server } from "../../../src/types";

const server = (fields: Partial<Server>) => fields as Server;

describe("presenceOf", () => {
  test("is connecting until the server has logged us in", () => {
    expect(
      presenceOf(
        server({
          isConnected: true,
          isRegistered: false,
          connectionState: "connected",
        }),
      ),
    ).toBe("connecting");
    expect(
      presenceOf(server({ isConnected: false, connectionState: "connecting" })),
    ).toBe("connecting");
  });

  test("is online or away once logged in", () => {
    const loggedIn = {
      isConnected: true,
      isRegistered: true,
      connectionState: "connected",
    } as const;
    expect(presenceOf(server(loggedIn))).toBe("online");
    expect(presenceOf(server({ ...loggedIn, isAway: true }))).toBe("away");
  });

  test("is offline without a connection or a server", () => {
    expect(
      presenceOf(
        server({ isConnected: false, connectionState: "disconnected" }),
      ),
    ).toBe("offline");
    expect(presenceOf(undefined)).toBe("offline");
  });
});
