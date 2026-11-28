import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { probeMediaUrl } from "../../src/lib/mediaProbe";
import type { MediaVisibilityLevel } from "../../src/lib/mediaUtils";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

function setMedia(level: MediaVisibilityLevel, hosts: string[]) {
  useStore.setState((state) => ({
    globalSettings: {
      ...state.globalSettings,
      mediaVisibilityLevel: level,
      mediaAllowedHosts: hosts,
    },
  }));
}

function storageEvent(key: string, newValue: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

describe("allowed media sites follow another tab", () => {
  let saved: string | null;

  beforeEach(() => {
    saved = null;
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === "globalSettings" ? saved : null,
    );
    vi.mocked(localStorage.setItem).mockClear();
    setMedia(1, ["a.example", "b.example"]);
  });
  afterEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
  });

  test("a site removed in another tab is removed here, without saving", () => {
    saved = JSON.stringify({
      mediaVisibilityLevel: 1,
      mediaAllowedHosts: ["b.example"],
    });
    storageEvent("globalSettings", saved);
    expect(useStore.getState().globalSettings.mediaAllowedHosts).toEqual([
      "b.example",
    ]);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  test("the saved list is sanitised on the way in", () => {
    saved = JSON.stringify({
      mediaAllowedHosts: ["*.co.uk", "b.example", "B.example", 5],
    });
    storageEvent("globalSettings", saved);
    expect(useStore.getState().globalSettings.mediaAllowedHosts).toEqual([
      "b.example",
    ]);
  });

  test("only this key follows the other tab", () => {
    saved = JSON.stringify({
      mediaVisibilityLevel: 3,
      mediaAllowedHosts: ["b.example"],
    });
    storageEvent("globalSettings", saved);
    expect(useStore.getState().globalSettings.mediaVisibilityLevel).toBe(1);
  });

  test("an unchanged list keeps its identity, so nothing re-renders", () => {
    const before = useStore.getState().globalSettings;
    saved = JSON.stringify({ mediaAllowedHosts: ["a.example", "b.example"] });
    storageEvent("globalSettings", saved);
    expect(useStore.getState().globalSettings).toBe(before);
  });

  test("another key or a cleared key changes nothing", () => {
    saved = JSON.stringify({ mediaAllowedHosts: [] });
    storageEvent("savedServers", saved);
    storageEvent("globalSettings", null);
    expect(useStore.getState().globalSettings.mediaAllowedHosts).toEqual([
      "a.example",
      "b.example",
    ]);
  });
});

describe("the store tells the probe which links are allowed-site only", () => {
  let n = 0;
  // A media extension settles the probe as soon as both requests fail.
  const fresh = (origin: string) => `${origin}/probe-${++n}.png`;

  // The probe refuses redirects exactly when the registered check says yes.
  async function redirectModeFor(url: string, serverId?: string) {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("blocked");
    });
    vi.stubGlobal("fetch", fetchMock);
    await probeMediaUrl(url, serverId);
    const init = (fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as
      | RequestInit
      | undefined;
    return init?.redirect;
  }

  beforeEach(() => {
    useStore.setState({
      servers: [
        {
          id: "s1",
          filehost: "https://files.example",
          channels: [],
          privateChats: [],
        } as unknown as Server,
        { id: "s2", channels: [], privateChats: [] } as unknown as Server,
      ],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.setState({ servers: [] });
  });

  test("a listed host at Safe is guarded", async () => {
    setMedia(1, ["listed1.example"]);
    expect(await redirectModeFor(fresh("https://listed1.example"))).toBe(
      "manual",
    );
  });

  test("the same host is not guarded at All Content or at Off", async () => {
    setMedia(3, ["listed2.example"]);
    expect(await redirectModeFor(fresh("https://listed2.example"))).toBe(
      "follow",
    );
    setMedia(0, ["listed3.example"]);
    expect(await redirectModeFor(fresh("https://listed3.example"))).toBe(
      "follow",
    );
  });

  test("a listed host that is the file host of the link's own server is not guarded", async () => {
    setMedia(1, ["files.example"]);
    expect(await redirectModeFor(fresh("https://files.example"), "s1")).toBe(
      "follow",
    );
  });

  test("a listed host that is only another server's file host is guarded", async () => {
    setMedia(1, ["files.example"]);
    expect(await redirectModeFor(fresh("https://files.example"), "s2")).toBe(
      "manual",
    );
    expect(await redirectModeFor(fresh("https://files.example"))).toBe(
      "manual",
    );
  });
});
