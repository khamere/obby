import { describe, expect, it } from "vitest";
import {
  buildNativeAddress,
  connectionKindOf,
} from "../../src/lib/serverAddress";

describe("buildNativeAddress", () => {
  it("keeps the path of a bouncer's WebSocket address", () => {
    expect(
      buildNativeAddress("wss://bouncer.example:443/socket", 443, true),
    ).toBe("wss://bouncer.example:443/socket");
  });

  it("keeps a query and takes the port from the address over the field", () => {
    expect(
      buildNativeAddress("wss://irc.example/ws?token=abc", 6697, false),
    ).toBe("wss://irc.example:6697/ws?token=abc");
    expect(buildNativeAddress("wss://irc.example:8443/ws", 443, true)).toBe(
      "wss://irc.example:8443/ws",
    );
  });

  it("builds a TLS socket address from a bare host", () => {
    expect(buildNativeAddress("irc.example", 6697, false)).toBe(
      "ircs://irc.example:6697",
    );
    expect(buildNativeAddress("irc.example", 443, true)).toBe(
      "wss://irc.example:443",
    );
  });

  it("lets a typed scheme win over the checkbox and drops paths for TCP", () => {
    expect(buildNativeAddress("ircs://irc.example:6697", 6697, true)).toBe(
      "ircs://irc.example:6697",
    );
    expect(buildNativeAddress("irc://irc.example/foo", 6667, true)).toBe(
      "irc://irc.example:6667",
    );
  });

  it("never doubles an embedded port", () => {
    expect(buildNativeAddress("ircs://irc.example:6697", 6697, false)).toBe(
      "ircs://irc.example:6697",
    );
  });

  it("reads the connection kind from a typed scheme only", () => {
    expect(connectionKindOf("wss://a/b")).toBe(true);
    expect(connectionKindOf("ircs://a")).toBe(false);
    expect(connectionKindOf("a.example")).toBeUndefined();
  });
});
