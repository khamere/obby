import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const platform = vi.hoisted(() => ({ isTauri: vi.fn(() => false) }));
vi.mock("../../src/lib/platformUtils", () => platform);

import {
  createSocket,
  TCPSocket,
  WebSocketWrapper,
} from "../../src/lib/socket";

describe("createSocket", () => {
  beforeEach(() => {
    invoke.mockClear();
    platform.isTauri.mockReturnValue(false);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the browser WebSocket for wss on the web", () => {
    const sockets: string[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string) {
          sockets.push(url);
        }
      },
    );
    const socket = createSocket("wss://bouncer.example:443/socket");
    expect(socket).toBeInstanceOf(WebSocketWrapper);
    expect(sockets).toEqual(["wss://bouncer.example:443/socket"]);
  });

  it("hands wss to the native socket in the apps, path included", () => {
    platform.isTauri.mockReturnValue(true);
    const socket = createSocket("wss://bouncer.example:443/socket?x=1");
    expect(socket).toBeInstanceOf(TCPSocket);
    expect(invoke).toHaveBeenCalledWith(
      "connect",
      expect.objectContaining({
        address: "wss://bouncer.example:443/socket?x=1",
      }),
    );
  });

  it("always uses the native socket for plain IRC addresses", () => {
    const socket = createSocket("ircs://irc.example:6697");
    expect(socket).toBeInstanceOf(TCPSocket);
  });

  it("refuses an unknown scheme", () => {
    expect(() => createSocket("http://irc.example")).toThrow(/Unsupported/);
  });
});
