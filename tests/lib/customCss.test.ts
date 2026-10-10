import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCustomCssState,
  isValidCssLink,
  loadCustomCss,
  resetCustomCssForTests,
  sanitizeCss,
  saveOwnCss,
  setCssLink,
} from "../../src/lib/customCss";
import { networkHost } from "../../src/lib/networkHost";
import type { Server } from "../../src/types";

const DATA = 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")';
const EVIL = /evil\.example/;

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
    expect(out).not.toMatch(EVIL);
    expect(out).not.toMatch(/@import/i);
  });

  it("sees through CSS escapes that spell url( or @import", () => {
    for (const sneaky of [
      ".a { background: \\75 rl(https://evil.example/p.png) }",
      ".a { background: u\\rl(https://evil.example/p.png) }",
      ".a { background: \\000075rl(https://evil.example/p.png) }",
      "@\\69 mport 'https://evil.example/x.css';",
    ]) {
      expect(sanitizeCss(sneaky)).not.toMatch(EVIL);
    }
  });

  it("normalises line endings like the browser before decoding escapes", () => {
    // "\75" + CRLF + "rl(" is url( to the browser: CRLF is one newline,
    // and the single whitespace after an escape is consumed.
    for (const ws of ["\r\n", "\r", "\f"]) {
      const out = sanitizeCss(
        `.a { background: \\75${ws}rl(https://evil.example/p.png) }`,
      );
      expect(out).not.toMatch(EVIL);
    }
  });

  it("disables functions that take a bare string URL, escaped or not", () => {
    const out = sanitizeCss(
      '.a { background: image("https://evil.example/a.png"); }\n' +
        '.b { background-image: src("https://evil.example/b.png"); }\n' +
        '.c { background: -webkit-image-set("https://evil.example/c.png" 1x); }\n' +
        '.d { background: \\69 mage("https://evil.example/d.png"); }\n' +
        '.e { background: \\73\r\nrc("https://evil.example/e.png"); }',
    );
    expect(out).not.toMatch(/(^|[^\w-])(-webkit-)?(image-set|image|src)\(/i);
  });

  it("leaves the @font-face src descriptor and data: fonts alone", () => {
    const css =
      '@font-face { font-family: x; src: url("data:font/woff2;base64,AA==") format("woff2"); }';
    expect(sanitizeCss(css)).toBe(css);
  });

  it("neutralises legacy script hooks and can't close <style>", () => {
    const out = sanitizeCss(
      ".a { width: expression(alert(1)) }</style><script>x</script>",
    );
    expect(out).not.toMatch(/expression\s*\(/);
    expect(out).not.toMatch(/<\/style/i);
  });
});

describe("isValidCssLink", () => {
  it("accepts only http(s) URLs", () => {
    expect(isValidCssLink("https://files.example/raw/logos.css")).toBe(true);
    expect(isValidCssLink("http://files.example/logos.css")).toBe(true);
    expect(isValidCssLink("javascript:alert(1)")).toBe(false);
    expect(isValidCssLink("data:text/css,a{}")).toBe(false);
    expect(isValidCssLink("not a url")).toBe(false);
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

describe("own and linked stylesheets", () => {
  const LINK = "https://files.example/raw/theme.css";
  let backing: Map<string, string>;
  let remote: { status: number; body: string };
  let fetchMock: ReturnType<typeof vi.fn>;

  function styleText() {
    return document.getElementById("obby-custom-css")?.textContent ?? null;
  }

  beforeEach(() => {
    resetCustomCssForTests();
    backing = new Map();
    remote = { status: 200, body: ".linked { color: blue; }" };
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((k) => {
      backing.delete(k);
    });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(LINK);
      // no cookies or referrer go to the third-party host
      expect(init).toMatchObject({
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      return new Response(remote.body, { status: remote.status });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    resetCustomCssForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("own CSS is applied and kept across reloads, without any request", () => {
    saveOwnCss("body { color: red; }");
    expect(styleText()).toBe("body { color: red; }");
    resetCustomCssForTests();
    loadCustomCss();
    expect(styleText()).toBe("body { color: red; }");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a link is fetched, applied before own CSS, and refreshed on startup", async () => {
    saveOwnCss(".own{}");
    await setCssLink(LINK);
    expect(getCustomCssState().linkStatus).toBe("ok");
    expect(styleText()).toBe(".linked { color: blue; }\n\n.own{}");

    remote.body = ".linked { color: green; }";
    resetCustomCssForTests();
    loadCustomCss();
    // last good copy applies immediately, then the update arrives
    expect(styleText()).toContain("blue");
    await vi.waitFor(() => expect(styleText()).toContain("green"));
  });

  it("keeps the cached copy when the host is down", async () => {
    await setCssLink(LINK);
    remote.status = 503;
    resetCustomCssForTests();
    loadCustomCss();
    await vi.waitFor(() =>
      expect(getCustomCssState().linkStatus).toBe("cached"),
    );
    expect(styleText()).toContain(".linked");
  });

  it("reports an error for a preview page instead of a raw file", async () => {
    remote.body = "<!doctype html><html>preview</html>";
    await setCssLink(LINK);
    expect(getCustomCssState().linkStatus).toBe("error");
    expect(styleText()).toBeNull();
  });

  it("linked CSS is sanitised too", async () => {
    remote.body = ".a { background: url(https://evil.example/x) }";
    await setCssLink(LINK);
    expect(styleText()).not.toMatch(EVIL);
  });

  it("refuses non-http links and can be removed", async () => {
    await expect(setCssLink("javascript:alert(1)")).rejects.toThrow();
    await setCssLink(LINK);
    await setCssLink("");
    expect(getCustomCssState()).toMatchObject({ link: "", linkCss: "" });
    expect(styleText()).toBeNull();
  });
});
