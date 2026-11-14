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
        isRegistered: true,
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

  it("marks the user back on the first input after a late confirmation", () => {
    renderHook(() => useAutoAway());
    vi.advanceTimersByTime(10 * MIN + 30_000);
    expect(setAway).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(clearAway).not.toHaveBeenCalled();

    setServer(true);
    vi.advanceTimersByTime(5_000);
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

  it("hands the server back when the user sets away or back themselves", () => {
    renderHook(() => useAutoAway());
    vi.advanceTimersByTime(10 * MIN + 30_000);
    setServer(true);
    vi.advanceTimersByTime(30_000);

    useStore.getState().setAway("s1", "lunch");
    expect(setAway).toHaveBeenLastCalledWith("s1", "lunch");
    window.dispatchEvent(new KeyboardEvent("keydown"));
    vi.advanceTimersByTime(60_000);
    expect(clearAway).not.toHaveBeenCalled();

    useStore.getState().clearAway("s1");
    expect(clearAway).toHaveBeenCalledTimes(1);
    setServer(false);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    vi.advanceTimersByTime(60_000);
    expect(clearAway).toHaveBeenCalledTimes(1);
  });

  it("counts waking from sleep as the user returning", () => {
    renderHook(() => useAutoAway());
    vi.advanceTimersByTime(60_000);

    vi.setSystemTime(Date.now() + 8 * 60 * MIN);
    vi.advanceTimersByTime(30_000);
    expect(setAway).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10 * MIN);
    expect(setAway).toHaveBeenCalledTimes(1);
  });

  it("counts the page becoming visible as activity", () => {
    renderHook(() => useAutoAway());
    vi.advanceTimersByTime(9 * MIN);

    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2 * MIN);
    expect(setAway).not.toHaveBeenCalled();
  });

  it("marks the user back when the setting is switched off while away", () => {
    renderHook(() => useAutoAway());
    vi.advanceTimersByTime(10 * MIN + 30_000);
    setServer(true);
    vi.advanceTimersByTime(30_000);

    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, autoAwayMinutes: 0 },
    }));
    vi.advanceTimersByTime(30_000);
    expect(clearAway).toHaveBeenCalledWith("s1");
  });

  it.each(["pointerdown", "pointermove", "wheel", "touchstart"])(
    "takes %s as activity",
    (type) => {
      renderHook(() => useAutoAway());
      vi.advanceTimersByTime(9 * MIN);

      window.dispatchEvent(new Event(type));
      vi.advanceTimersByTime(2 * MIN);
      expect(setAway).not.toHaveBeenCalled();
    },
  );

  it("does nothing while switched off", () => {
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, autoAwayMinutes: 0 },
    }));
    renderHook(() => useAutoAway());

    vi.advanceTimersByTime(120 * MIN);
    expect(setAway).not.toHaveBeenCalled();
  });
});
