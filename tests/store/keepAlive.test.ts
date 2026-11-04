import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "../../src/types";

const bridge = vi.hoisted(() => ({
  setKeepAlive: vi.fn(() => Promise.resolve()),
  requestBatteryExemption: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../src/lib/keepAlive", () => bridge);
const platform = vi.hoisted(() => ({ isTauriAndroid: vi.fn(() => true) }));
vi.mock("../../src/lib/platformUtils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...platform,
}));

import useStore from "../../src/store";
import { registerKeepAliveHandlers } from "../../src/store/handlers/keepAlive";

const server = (id: string, isConnected: boolean): Server =>
  ({
    id,
    name: id,
    host: id,
    port: 6697,
    isConnected,
    channels: [],
    privateChats: [],
  }) as unknown as Server;

describe("keep-alive service", () => {
  let backing: Map<string, string>;
  beforeEach(() => {
    bridge.setKeepAlive.mockClear();
    bridge.requestBatteryExemption.mockClear();
    backing = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
    useStore.setState((state) => ({
      servers: [],
      globalSettings: { ...state.globalSettings, keepConnectionAlive: true },
    }));
  });

  it("does nothing off Android", () => {
    platform.isTauriAndroid.mockReturnValueOnce(false);
    registerKeepAliveHandlers(useStore);
    expect(bridge.setKeepAlive).not.toHaveBeenCalled();
  });
  it("follows the connected networks and asks for the battery exemption once", () => {
    registerKeepAliveHandlers(useStore);
    expect(bridge.setKeepAlive).toHaveBeenCalledWith(
      false,
      expect.any(String),
      expect.any(String),
    );
    useStore.setState({ servers: [server("a", true), server("b", true)] });
    expect(bridge.setKeepAlive).toHaveBeenLastCalledWith(
      true,
      "Connected to 2 networks",
      "Connection",
    );
    expect(bridge.requestBatteryExemption).toHaveBeenCalledTimes(1);
    useStore.setState({ servers: [server("a", true), server("b", false)] });
    expect(bridge.setKeepAlive).toHaveBeenLastCalledWith(
      true,
      "Connected to 1 network",
      "Connection",
    );
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, keepConnectionAlive: false },
    }));
    expect(bridge.setKeepAlive).toHaveBeenLastCalledWith(
      false,
      expect.any(String),
      "Connection",
    );
    useStore.setState({ servers: [server("a", true), server("c", true)] });
    expect(bridge.requestBatteryExemption).toHaveBeenCalledTimes(1);
  });
});
