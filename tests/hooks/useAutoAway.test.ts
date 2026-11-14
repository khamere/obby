import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoAway } from "../../src/hooks/useAutoAway";
import { setAutoAwayRecord } from "../../src/lib/autoAway";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

const MIN = 60_000;

const setServer = (isAway: boolean) =>
  useStore.setState({
    servers: [
      {
        id: "s1",
        isConnected: true,
        isAway,
        channels: [],
        privateChats: [],
      } as unknown as Server,
    ],
  });

describe("useAutoAway", () => {
  let setAway: ReturnType<typeof vi.spyOn>;
  let clearAway: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setAutoAwayRecord(new Map());
    setAway = vi.spyOn(ircClient, "setAway").mockImplementation(() => {});
    clearAway = vi.spyOn(ircClient, "clearAway").mockImplementation(() => {});
    useStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        autoAwayMinutes: 10,
        awayMessage: "gone fishing",
      },
    }));
    setServer(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks the user away after the idle time and back on the next input", () => {
    renderHook(() => useAutoAway());

    vi.advanceTimersByTime(9 * MIN);
    expect(setAway).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MIN + 30_000);
    expect(setAway).toHaveBeenCalledWith("s1", "gone fishing");
    expect(setAway).toHaveBeenCalledTimes(1);

    setServer(true);
    vi.advanceTimersByTime(30_000);
    expect(setAway).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(clearAway).toHaveBeenCalledWith("s1");
  });

  it("never marks the user back from an away they set themselves", () => {
    renderHook(() => useAutoAway());
    setServer(true);

    vi.advanceTimersByTime(20 * MIN);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    vi.advanceTimersByTime(30_000);

    expect(setAway).not.toHaveBeenCalled();
    expect(clearAway).not.toHaveBeenCalled();
  });

  it("does nothing while switched off", () => {
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, autoAwayMinutes: 0 },
    }));
    renderHook(() => useAutoAway());

    vi.advanceTimersByTime(120 * MIN);
    expect(setAway).not.toHaveBeenCalled();
  });
});
