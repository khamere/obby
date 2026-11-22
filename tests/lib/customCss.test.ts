import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCustomCssState,
  isValidCssLink,
  loadCustomCss,
  namespacePrefixRules,
  resetCustomCssForTests,
  sanitizeCss,
  saveOwnCss,
  setCssLink,
} from "../../src/lib/customCss";
import { networkHost } from "../../src/lib/networkHost";
import type { Server } from "../../src/types";
import { remoteReferences } from "./cssTokenizer";
import { BYPASS_ATTEMPTS } from "./customCssBypasses";

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

  it("neutralises a url( left open at the end of the stylesheet", () => {
    for (const sneaky of [
      ".a { background: url(https://evil.example/p.png",
      ".a { background: url('https://evil.example/p.png",
      '.a { background: url("https://evil.example/p.png',
      ".a { background: \\75 rl(https://evil.example/p.png",
    ]) {
      expect(sanitizeCss(sneaky)).not.toMatch(EVIL);
    }
    // a data: URL that is closed stays, even when followed by an open one
    const out = sanitizeCss(
      `.a { background: ${DATA} } .b { background: url(https://evil.example/p.png`,
    );
    expect(out).toContain(DATA);
    expect(out).not.toMatch(EVIL);
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
    expect(remoteReferences(out)).toEqual([]);
    expect(out).toBe(
      '.a { background: invalid-url-fn("https://evil.example/a.png"); }\n' +
        '.b { background-image: invalid-url-fn("https://evil.example/b.png"); }\n' +
        '.c { background: invalid-url-fn("https://evil.example/c.png" 1x); }\n' +
        '.d { background: invalid-url-fn("https://evil.example/d.png"); }\n' +
        '.e { background: invalid-url-fn("https://evil.example/e.png"); }',
    );
  });

  it("leaves the @font-face src descriptor and data: fonts alone", () => {
    const css =
      '@font-face { font-family: x; src: url("data:font/woff2;base64,AA==") format("woff2"); }';
    expect(sanitizeCss(css)).toBe(css);
  });

  it.each(BYPASS_ATTEMPTS)(
    "blocks a remote address hidden by %s",
    (_name, css, inert) => {
      // an attempt has to be live as written, or sanitising it proves nothing
      expect(remoteReferences(css).length > 0).toBe(!inert);
      const out = sanitizeCss(css);
      expect(remoteReferences(out)).toEqual([]);
      expect(out).not.toBe("");
      expect(sanitizeCss(out)).toBe(out);
    },
  );

  it("reads the url( after <!-- as an address", () => {
    expect(
      sanitizeCss(
        '.z{x:<!--url(a" b)} .a{background:url(https://evil.example/a)} .b{content:"}',
      ),
    ).toBe('.z{x:<!--none} .a{background:none} .b{content:"}"');
  });

  it("keeps custom functions and other names that only end like a URL function", () => {
    const css =
      "@function --theme-image(--a){result:var(--a)} @function --theme-src(){result:red}" +
      " .a{background:--theme-image(red);color:--theme-src();x:my-url(data:x) --url(y) element(#src) -x-my-image-set(z)}";
    expect(sanitizeCss(css)).toBe(css);
  });

  it("still filters the arguments and the result of a custom function", () => {
    expect(
      sanitizeCss(
        '@function --theme-src(){result:url(https://evil.example/a)} .a{background:--theme-image(url("https://evil.example/b") image-set("https://evil.example/c" 1x))}',
      ),
    ).toBe(
      '@function --theme-src(){result:none} .a{background:--theme-image(none invalid-url-fn("https://evil.example/c" 1x))}',
    );
  });

  it("separates a name from a URL function that another engine would start after it", () => {
    expect(sanitizeCss(".a{x:\u00a0url(data:x) 1\u00a0url(y)}")).toBe(
      ".a{x:\u00a0/**/url(data:x) 1\u00a0/**/none}",
    );
    expect(
      sanitizeCss(".a{x:u+123456url(y) a\u00a0u+1url(y) u+a\\75rl(y)}"),
    ).toBe(".a{x:u+123456/**/none a\u00a0u+1/**/none u+a/**/none}");
    for (const css of [
      "@font-face{font-family:f;unicode-range:U+0025-00FF,u+4??,U+26}",
      "u+abbr,u+code.x,U+b\\41,a\u00a0u+1b{color:red} u+26",
    ]) {
      expect(sanitizeCss(css)).toBe(css);
    }
  });

  it("gives the same text when its own output is sanitised again", () => {
    const out = sanitizeCss(".a{x:url(https://evil.example/a)1url(.b)}");
    expect(out).toBe(".a{x:none 1url(.b)}");
    expect(sanitizeCss(out)).toBe(out);
  });

  it("keeps numbers, colours and HTML comment marks as written", () => {
    const css =
      "<!-- .a{margin:.5em 1e3px -1.5rem;color:#fff;width:calc(100% - 1px)} --> #url{--bg-url:1url;line-height:1.}";
    expect(sanitizeCss(css)).toBe(css);
  });

  it("joins no pieces into a new url( when it removes an @import", () => {
    expect(
      sanitizeCss(".a{background:ur@import x;l(https://evil.example/p.png)}"),
    ).toBe(".a{background:ur/**/l(https://evil.example/p.png)}");
    // a space in place of the comment would be swallowed by the hex escape
    const out = sanitizeCss(
      ".a{background:u\\72@import x;l(https://evil.example/p.png)}",
    );
    expect(out).toBe(".a{background:u\\72/**/l(https://evil.example/p.png)}");
    expect(remoteReferences(out)).toEqual([]);
  });

  it("keeps a word it writes apart from the text that follows", () => {
    expect(sanitizeCss(".a{x:url(y)z url(y)(z) url(y)\\41}")).toBe(
      ".a{x:none z none (z) none \\41}",
    );
  });

  it("keeps a large inline image in a string as written", () => {
    const image = `url("data:image/png;base64,${"QUJD".repeat(250_000)}")`;
    const css = `.a{background:${image}} .b{background:url(https://evil.example/a)}`;
    expect(sanitizeCss(css)).toBe(
      `.a{background:${image}} .b{background:none}`,
    );
  });

  it("tells a data: address apart by its decoded start only", () => {
    const css =
      ".a{background:url( \\64 ata:x),url('\\\ndata:y'),url(\\9 DATA:z)}";
    expect(sanitizeCss(css)).toBe(css);
    expect(sanitizeCss(".a{background:url(dat),url('data'),url(xdata:)}")).toBe(
      ".a{background:none,none,none}",
    );
  });

  it("leaves nothing to fetch in stylesheets put together at random", () => {
    const pieces = [
      "url(",
      "URL(",
      "u\\72l(",
      "\\75 rl(",
      "image-set(",
      "src(",
      "@import ",
      "@im\\70ort",
      "https://evil.example/x",
      "data:x",
      '"',
      "'",
      ")",
      "(",
      "{",
      "}",
      ";",
      " ",
      "\n",
      "\\",
      "\\72",
      "\\72 ",
      "/*",
      "*/",
      "<!--",
      "-->",
      "</style",
      "u+1",
      "u+a?",
      "\u00a0",
      "\u2028",
      "1",
      "1e",
      "#",
      "@",
      "-",
      "a",
      "l",
      ".a{background:",
      "x:",
      "--f(",
      "!",
      "%",
      ".",
      "+",
    ];
    // a fixed seed, so every run sanitises the same stylesheets
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let live = 0;
    for (let i = 0; i < 4000; i++) {
      let css = "";
      const length = 2 + Math.floor(random() * 14);
      for (let n = 0; n < length; n++) {
        css += pieces[Math.floor(random() * pieces.length)];
      }
      if (remoteReferences(css).length > 0) live++;
      const out = sanitizeCss(css);
      expect(remoteReferences(out), css).toEqual([]);
      expect(out, css).not.toBe("");
      expect(sanitizeCss(out), css).toBe(out);
    }
    expect(live).toBeGreaterThan(1000);
  });

  it("keeps text inside strings and comments as written", () => {
    const css =
      '/* see url(https://docs.example/a) */ .a::after { content: "url(https://docs.example/b) @import image(\\"x\\")"; }';
    expect(sanitizeCss(css)).toBe(css);
  });

  it("keeps a data: image whose text contains quotes and parentheses", () => {
    const css = `.a { background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><path transform='scale(2)'/></svg>") }`;
    expect(sanitizeCss(css)).toBe(css);
  });

  it("closes a string or comment left open at the end", () => {
    // so CSS joined on after the result starts outside any string or comment
    expect(sanitizeCss('.a{content:"x')).toBe('.a{content:"x"');
    expect(sanitizeCss('.a{content:"x\\')).toBe('.a{content:"x"');
    expect(sanitizeCss(".a{} /* note")).toBe(".a{} /* note*/");
  });

  it("copes with deeply nested brackets", () => {
    const deep = `@import ${"(".repeat(200_000)};`;
    expect(sanitizeCss(deep)).toBe("/**/");
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
  const server = {
    name: "n",
    host: "ircs://IRC.Uplink.Example:6697",
    port: 6697,
  };
  it("is the upstream host, from soju for bound networks", () => {
    expect(networkHost(server as Server)).toBe("irc.uplink.example");
    expect(
      networkHost(
        { ...server, host: "soju.example", bouncerNetid: "1" } as Server,
        { netid: "1", attributes: { host: "irc.alder.example" } },
      ),
    ).toBe("irc.alder.example");
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
  function linkStyleText() {
    return document.getElementById("obby-custom-css-link")?.textContent ?? null;
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
    expect(linkStyleText()).toBe(".linked { color: blue; }");
    expect(styleText()).toBe(".own{}");
    const styles = [...document.head.querySelectorAll("style")].map(
      (el) => el.id,
    );
    expect(styles.slice(-2)).toEqual([
      "obby-custom-css-link",
      "obby-custom-css",
    ]);

    remote.body = ".linked { color: green; }";
    resetCustomCssForTests();
    loadCustomCss();
    // last good copy applies immediately, then the update arrives
    expect(linkStyleText()).toContain("blue");
    await vi.waitFor(() => expect(linkStyleText()).toContain("green"));
    expect(styleText()).toBe(".own{}");
  });

  it("keeps a block the linked file leaves open away from own CSS", async () => {
    remote.body = '.q{content:"open';
    await setCssLink(LINK);
    saveOwnCss("#root{outline-style:dashed}");
    expect(linkStyleText()).toBe('.q{content:"open"');
    expect(styleText()).toBe("#root{outline-style:dashed}");
  });

  it("repeats the linked file's namespace prefixes for own CSS", async () => {
    remote.body =
      '@charset "utf-8"; /* theme */ @namespace svg "http://www.w3.org/2000/svg";\n' +
      '@namespace "http://www.w3.org/1999/xhtml"; @namespace m\\6c "http://www.w3.org/1998/Math/MathML";\n' +
      '.q{color:red} @namespace late "urn:late"; .r{content:"open';
    await setCssLink(LINK);
    expect(styleText()).toBeNull();
    saveOwnCss("svg|path{fill:red}");
    expect(styleText()).toBe(
      '@namespace svg/**/"http://www.w3.org/2000/svg";\n' +
        '@namespace m\\6c /**/"http://www.w3.org/1998/Math/MathML";\n' +
        "svg|path{fill:red}",
    );
    expect(getCustomCssState().own).toBe("svg|path{fill:red}");
    await setCssLink("");
    expect(styleText()).toBe("svg|path{fill:red}");
  });

  it("repeats no namespace rule that is malformed or left open", () => {
    for (const css of [
      '@namespace svg "http://www.w3.org/2000/svg"',
      '@namespace svg "http://www.w3.org/2000/svg',
      '@namespace svg "http://www.w3.org/2000/svg" {',
      '@namespace svg x "http://www.w3.org/2000/svg";',
      "@namespace svg none;",
      '.a{} @namespace svg "http://www.w3.org/2000/svg";',
      '@layer a{} @namespace svg "http://www.w3.org/2000/svg";',
      '@media screen{} @namespace svg "http://www.w3.org/2000/svg";',
    ]) {
      expect(namespacePrefixRules(sanitizeCss(css)), css).toBe("");
    }
    expect(
      namespacePrefixRules(
        '@layer a, b; <!-- @namespace svg "http://www.w3.org/2000/svg"; -->',
      ),
    ).toBe('@namespace svg/**/"http://www.w3.org/2000/svg";');
  });

  it("keeps the cached copy when the host is down", async () => {
    await setCssLink(LINK);
    remote.status = 503;
    resetCustomCssForTests();
    loadCustomCss();
    await vi.waitFor(() =>
      expect(getCustomCssState().linkStatus).toBe("cached"),
    );
    expect(linkStyleText()).toContain(".linked");
  });

  it("reports an error for a preview page instead of a raw file", async () => {
    remote.body = "<!doctype html><html>preview</html>";
    await setCssLink(LINK);
    expect(getCustomCssState().linkStatus).toBe("error");
    expect(getCustomCssState().linkCss).toBe("");
    expect(linkStyleText()).toBeNull();
    expect(styleText()).toBeNull();
  });

  it("linked CSS is sanitised too", async () => {
    remote.body = ".a { background: url(https://evil.example/x) }";
    await setCssLink(LINK);
    expect(linkStyleText()).toBe(".a { background: none }");
  });

  it("refuses non-http links and can be removed", async () => {
    await expect(setCssLink("javascript:alert(1)")).rejects.toThrow();
    await setCssLink(LINK);
    await setCssLink("");
    expect(getCustomCssState()).toMatchObject({ link: "", linkCss: "" });
    expect(linkStyleText()).toBeNull();
  });
});
