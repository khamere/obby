import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_TOKENS } from "../../src/lib/theme";
import {
  getThemeLinkState,
  loadThemeLink,
  resetThemeLinkForTests,
  setThemeLink,
} from "../../src/lib/themeLink";

const backing = new Map<string, string>();
const theme = {
  id: "shared",
  name: "Shared",
  appearance: "dark",
  colors: Object.fromEntries(THEME_TOKENS.map((t) => [t, "#223344"])),
};

function mockFetch(body: string, ok = true) {
  const fn = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 404,
    text: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("themes by link", () => {
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
    vi.mocked(window.localStorage.removeItem).mockImplementation(
      (k: string) => {
        backing.delete(k);
      },
    );
    resetThemeLinkForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a theme without cookies or referrer, validates and caches it", async () => {
    const fetchFn = mockFetch(JSON.stringify(theme));
    await setThemeLink("https://example.org/theme.json");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.org/theme.json",
      expect.objectContaining({
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
    const s = getThemeLinkState();
    expect(s.status).toBe("ok");
    expect(s.theme?.name).toBe("Shared");
    expect(backing.get("obby.themeLink")).toBe(
      "https://example.org/theme.json",
    );
    expect(JSON.parse(backing.get("obby.themeLink.cache") ?? "{}").id).toBe(
      "shared",
    );
  });

  it("rejects a file that is not a valid theme", async () => {
    mockFetch(
      JSON.stringify({ ...theme, colors: { ...theme.colors, fg: "url(x)" } }),
    );
    await setThemeLink("https://example.org/bad.json");
    expect(getThemeLinkState().status).toBe("error");
    expect(getThemeLinkState().theme).toBeNull();
  });

  it("rejects non-http links and clears on empty", async () => {
    await expect(setThemeLink("ftp://x/theme.json")).rejects.toThrow();
    mockFetch(JSON.stringify(theme));
    await setThemeLink("https://example.org/theme.json");
    await setThemeLink("");
    expect(getThemeLinkState()).toMatchObject({
      link: "",
      theme: null,
      status: "none",
    });
    expect(backing.has("obby.themeLink")).toBe(false);
  });

  it("applies the cached copy at startup and keeps it when the host is down", async () => {
    backing.set("obby.themeLink", "https://example.org/theme.json");
    backing.set("obby.themeLink.cache", JSON.stringify(theme));
    mockFetch("", false);
    loadThemeLink();
    expect(getThemeLinkState().theme?.id).toBe("shared");
    await new Promise((r) => setTimeout(r, 0));
    expect(getThemeLinkState().status).toBe("cached");
    expect(getThemeLinkState().theme?.id).toBe("shared");
  });
});
