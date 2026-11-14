import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "../../src/types";

const bridge = vi.hoisted(() => ({
  setKeepAlive: vi.fn((_enabled: boolean, _status: string, _channel: string) =>
    Promise.resolve(),
  ),
  requestBatteryExemption: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../src/lib/keepAlive", () => bridge);
// The store registers the handler itself at import; it stays inert there so
// each test owns the one it registers.
const platform = vi.hoisted(() => ({ isTauriAndroid: vi.fn(() => false) }));
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

// The native calls are queued, so every expectation waits for the queue.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastCall = () =>
  bridge.setKeepAlive.mock.calls[bridge.setKeepAlive.mock.calls.length - 1];

describe("keep-alive service", () => {
  let backing: Map<string, string>;
  let stop: () => void = () => {};
  beforeEach(() => {
    platform.isTauriAndroid.mockReturnValue(true);
    useStore.setState((state) => ({
      servers: [],
      globalSettings: { ...state.globalSettings, keepConnectionAlive: true },
    }));
    bridge.setKeepAlive.mockClear();
    bridge.requestBatteryExemption.mockClear();
    backing = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
  });
  afterEach(() => stop());

  it("retries a rejected stop by itself", async () => {
    vi.useFakeTimers();
    try {
      stop = registerKeepAliveHandlers(useStore);
      await vi.advanceTimersByTimeAsync(0);
      useStore.setState({ servers: [server("a", true)] });
      await vi.advanceTimersByTimeAsync(0);
      bridge.setKeepAlive.mockImplementationOnce(() =>
        Promise.reject(new Error("stopService refused")),
      );
      useStore.setState({ servers: [] });
      await vi.advanceTimersByTimeAsync(0);
      const before = bridge.setKeepAlive.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(bridge.setKeepAlive.mock.calls.length).toBe(before + 1);
      expect(lastCall()[0]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for the battery exemption only once the app is visible", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      stop = registerKeepAliveHandlers(useStore);
      useStore.setState({ servers: [server("a", true)] });
      await settle();
      expect(bridge.requestBatteryExemption).not.toHaveBeenCalled();
      expect(backing.has("obby.batteryExemptionAsked")).toBe(false);
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(bridge.requestBatteryExemption).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(bridge.requestBatteryExemption).toHaveBeenCalledTimes(1);
    } finally {
      visibility.mockRestore();
    }
  });

  it("makes no call after cleanup, even for a request that fails late", async () => {
    vi.useFakeTimers();
    try {
      let fail: (error: Error) => void = () => {};
      stop = registerKeepAliveHandlers(useStore);
      await vi.advanceTimersByTimeAsync(0);
      bridge.setKeepAlive.mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            fail = reject;
          }),
      );
      useStore.setState({ servers: [server("a", true)] });
      await vi.advanceTimersByTimeAsync(0);
      const before = bridge.setKeepAlive.mock.calls.length;
      stop();
      fail(new Error("too late"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(bridge.setKeepAlive.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing off Android", async () => {
    platform.isTauriAndroid.mockReturnValueOnce(false);
    stop = registerKeepAliveHandlers(useStore);
    await settle();
    expect(bridge.setKeepAlive).not.toHaveBeenCalled();
  });

  it("follows the connected networks and asks for the battery exemption once", async () => {
    stop = registerKeepAliveHandlers(useStore);
    await settle();
    expect(lastCall()).toEqual([false, "", ""]);
    useStore.setState({ servers: [server("a", true), server("b", true)] });
    await settle();
    expect(lastCall()).toEqual([true, "Connected to 2 networks", "Connection"]);
    expect(bridge.requestBatteryExemption).toHaveBeenCalledTimes(1);
    useStore.setState({ servers: [server("a", true), server("b", false)] });
    await settle();
    expect(lastCall()).toEqual([true, "Connected to 1 network", "Connection"]);
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, keepConnectionAlive: false },
    }));
    await settle();
    expect(lastCall()).toEqual([false, "", ""]);
    useStore.setState({ servers: [server("a", true), server("c", true)] });
    await settle();
    expect(bridge.requestBatteryExemption).toHaveBeenCalledTimes(1);
  });

  it("sends changes in order and retries a refused start once the app is visible", async () => {
    let release: () => void = () => {};
    stop = registerKeepAliveHandlers(useStore);
    await settle();
    bridge.setKeepAlive.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    useStore.setState({ servers: [server("a", true)] });
    await settle();
    useStore.setState({ servers: [server("a", false)] });
    await settle();
    // The stop waits for the start to settle.
    expect(bridge.setKeepAlive).toHaveBeenCalledTimes(2);
    release();
    await settle();
    expect(bridge.setKeepAlive).toHaveBeenCalledTimes(3);
    expect(lastCall()[0]).toBe(false);

    bridge.setKeepAlive.mockImplementationOnce(() =>
      Promise.reject(new Error("background start refused")),
    );
    useStore.setState({ servers: [server("a", true)] });
    await settle();
    const before = bridge.setKeepAlive.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bridge.setKeepAlive.mock.calls.length).toBe(before + 1);
    expect(lastCall()[0]).toBe(true);
  });
});
