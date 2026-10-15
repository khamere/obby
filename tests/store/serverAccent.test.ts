import { beforeEach, describe, expect, it, vi } from "vitest";
import useStore from "../../src/store";

const backing = new Map<string, string>();

describe("per-network accent", () => {
  beforeEach(() => {
    backing.clear();
    vi.mocked(window.localStorage.getItem).mockImplementation(
      (k: string) => backing.get(k) ?? null,
    );
    vi.mocked(window.localStorage.setItem).mockImplementation(
      (k: string, v: string) => {
        backing.set(k, v);
      },
    );
    backing.set(
      "savedServers",
      JSON.stringify([
        { id: "s1", host: "irc.a", port: 6697, nickname: "me", channels: [] },
      ]),
    );
    useStore.setState({ serverAccents: {} });
  });

  it("updateServer records the accent so the UI can react without a reload", () => {
    useStore.getState().updateServer("s1", { accentColor: "#ff00aa" });
    expect(useStore.getState().serverAccents).toEqual({ s1: "#ff00aa" });
    expect(JSON.parse(backing.get("savedServers") ?? "[]")[0].accentColor).toBe(
      "#ff00aa",
    );
  });

  it("clearing the accent removes it", () => {
    useStore.getState().updateServer("s1", { accentColor: "#ff00aa" });
    useStore.getState().updateServer("s1", { accentColor: "" });
    expect(useStore.getState().serverAccents).toEqual({});
  });
});
