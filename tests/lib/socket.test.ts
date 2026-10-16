import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { createSocket, TCPSocket } from "../../src/lib/socket";

describe("createSocket", () => {
  afterEach(() => {
    delete window.__TAURI__;
  });

  it("uses the native transport for plaintext WebSockets on Android", () => {
    const userAgent = Object.getOwnPropertyDescriptor(
      window.navigator,
      "userAgent",
    );
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 16)",
    });
    window.__TAURI__ = {};

    try {
      expect(createSocket("ws://irc.example.com:80/socket")).toBeInstanceOf(
        TCPSocket,
      );
    } finally {
      if (userAgent) {
        Object.defineProperty(window.navigator, "userAgent", userAgent);
      } else {
        Reflect.deleteProperty(window.navigator, "userAgent");
      }
    }
  });

  it("uses the native transport for WSS on Android Tauri", () => {
    const userAgent = Object.getOwnPropertyDescriptor(
      window.navigator,
      "userAgent",
    );
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 16)",
    });
    window.__TAURI__ = {};

    try {
      expect(createSocket("wss://irc.example.com/socket")).toBeInstanceOf(
        TCPSocket,
      );
    } finally {
      if (userAgent) {
        Object.defineProperty(window.navigator, "userAgent", userAgent);
      } else {
        Reflect.deleteProperty(window.navigator, "userAgent");
      }
    }
  });
});
