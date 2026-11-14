import { describe, expect, test } from "vitest";
import { isServerConnecting } from "../../src/store/helpers";
import type { Server } from "../../src/types";

const server = (fields: Partial<Server>) => fields as Server;

describe("isServerConnecting", () => {
  test("covers the wait for the socket", () => {
    expect(
      isServerConnecting(
        server({ isConnected: false, connectionState: "connecting" }),
      ),
    ).toBe(true);
  });

  test("covers the login after the socket has opened", () => {
    expect(
      isServerConnecting(
        server({
          isConnected: true,
          isRegistered: false,
          connectionState: "connected",
        }),
      ),
    ).toBe(true);
  });

  test("covers a retry after a lost connection", () => {
    expect(
      isServerConnecting(
        server({ isConnected: false, connectionState: "reconnecting" }),
      ),
    ).toBe(true);
  });

  test("ends once we are logged in, and never starts for a server left alone", () => {
    expect(
      isServerConnecting(
        server({
          isConnected: true,
          isRegistered: true,
          connectionState: "connected",
        }),
      ),
    ).toBe(false);
    expect(
      isServerConnecting(
        server({ isConnected: false, connectionState: "disconnected" }),
      ),
    ).toBe(false);
    expect(isServerConnecting(undefined)).toBe(false);
  });
});
