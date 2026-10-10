import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCustomCssState,
  loadCustomCss,
  resetCustomCssForTests,
  SHARED_CSS_PATH,
  sanitizeCss,
  saveCustomCss,
} from "../../src/lib/customCss";
import { networkHost } from "../../src/lib/networkHost";
import type { Server } from "../../src/types";

const DATA = 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")';

describe("sanitizeCss", () => {
  it("keeps ordinary rules and inline data: images", () => {
    const css = `.a { color: red; background: ${DATA} left / contain; }`;
    expect(sanitizeCss(css)).toBe(css);
  });

  it("removes @import and remote url()s", () => {
    const out = sanitizeCss(
      '@import "https://evil.example/x.css";\n' +
        ".a { background: url(https://evil.example/p.png) }\n" +
        "@font-face { src: url('//evil.example/f.woff') }",
    );
    expect(out).not.toMatch(/evil\.example/);
    expect(out).not.toMatch(/@import/i);
  });

  it("sees through CSS escapes that spell url( or @import", () => {
    for (const sneaky of [
      ".a { background: \\75 rl(https://evil.example/p.png) }",
      ".a { background: u\\rl(https://evil.example/p.png) }",
      "@\\69 mport 'https://evil.example/x.css';",
    ]) {
      expect(sanitizeCss(sneaky)).not.toMatch(/evil\.example/);
    }
  });

  it("neutralises image-set and legacy script hooks", () => {
    const out = sanitizeCss(
      '.a { background: image-set("https://evil.example/a.png" 1x); width: expression(alert(1)); }',
    );
    expect(out).not.toMatch(/(^|[^-])image-set\(/);
    expect(out).not.toMatch(/expression\s*\(/);
  });

  it("can't close the <style> element", () => {
    expect(sanitizeCss("</style><script>x</script>")).not.toMatch(/<\/style/i);
  });
});

describe("networkHost (data-network-host)", () => {
  const server = { name: "n", host: "ircs://IRC.Upload.CX:6697", port: 6697 };
  it("is the upstream host, from soju for bound networks", () => {
    expect(networkHost(server as Server)).toBe("irc.upload.cx");
    expect(
      networkHost(
        { ...server, host: "soju.example", bouncerNetid: "1" } as Server,
        { netid: "1", attributes: { host: "irc.lst.gg" } },
      ),
    ).toBe("irc.lst.gg");
    expect(networkHost({ ...server, isBouncerControl: true } as Server)).toBe(
      "",
    );
  });
});

describe("storing and applying", () => {
  let serverFile: string | null;
  let acceptPut: boolean;
  let backing: Map<string, string>;

  function styleText() {
    return document.getElementById("obby-custom-css")?.textContent ?? null;
  }

  beforeEach(() => {
    resetCustomCssForTests();
    serverFile = null;
    acceptPut = true;
    backing = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((k) => {
      backing.delete(k);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(SHARED_CSS_PATH);
        if (init?.method === "PUT") {
          if (!acceptPut) return new Response("", { status: 405 });
          serverFile = String(init.body);
          return new Response("", { status: 201 });
        }
        return serverFile === null
          ? new Response("<!doctype html><html></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            })
          : new Response(serverFile, {
              status: 200,
              headers: { "content-type": "text/css" },
            });
      }),
    );
  });
  afterEach(() => {
    resetCustomCssForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a save is applied, uploaded, and picked up by a fresh browser", async () => {
    const { savedOnServer } = await saveCustomCss("body { color: red; }");
    expect(savedOnServer).toBe(true);
    expect(getCustomCssState().source).toBe("server");
    expect(styleText()).toBe("body { color: red; }");

    resetCustomCssForTests();
    backing.clear(); // another browser
    loadCustomCss();
    await vi.waitFor(() =>
      expect(getCustomCssState()).toEqual({
        css: "body { color: red; }",
        source: "server",
      }),
    );
    expect(styleText()).toBe("body { color: red; }");
  });

  it("without server storage it stays in this browser, across reloads", async () => {
    acceptPut = false;
    const { savedOnServer } = await saveCustomCss(".a{}");
    expect(savedOnServer).toBe(false);
    expect(getCustomCssState().source).toBe("local");

    resetCustomCssForTests();
    loadCustomCss();
    await vi.waitFor(() => expect(getCustomCssState().source).toBe("local"));
    expect(styleText()).toBe(".a{}");
  });

  it("a local-only save isn't hidden by an older server copy", async () => {
    serverFile = ".old{}";
    acceptPut = false;
    await saveCustomCss(".new{}");
    resetCustomCssForTests();
    loadCustomCss();
    await new Promise((r) => setTimeout(r, 0));
    expect(getCustomCssState().css).toBe(".new{}");
  });

  it("removing clears it for every browser", async () => {
    await saveCustomCss(".a{}");
    const { savedOnServer } = await saveCustomCss("");
    expect(savedOnServer).toBe(true);
    expect(serverFile).toBe("");
    expect(getCustomCssState().source).toBe("none");
    expect(styleText()).toBeNull();
  });

  it("what gets stored and applied is the sanitised stylesheet", async () => {
    await saveCustomCss(".a { background: url(https://evil.example/x) }");
    expect(serverFile).not.toMatch(/evil/);
    expect(styleText()).not.toMatch(/evil/);
  });
});
