import { useSyncExternalStore } from "react";

// A user stylesheet applied on top of the app (themes, fonts, per-network
// styling via the sidebar's data-network-host attribute, ...). Two sources,
// both kept in this browser:
//   - linked: a CSS file at a URL the user chose, fetched at startup so
//     everyone who uses the same link gets updates; the last good copy is
//     cached so it applies immediately and survives the host being down.
//   - own: CSS pasted or uploaded in Settings, applied after the linked file
//     so personal tweaks win.
//
// Everything is sanitised: @import, remote url()s and other functions that
// take a URL are removed, so a stylesheet can never make the browser fetch
// anything. The only request is the one for the link itself, which the user
// opts into.

const OWN_KEY = "obby.customCss";
const LINK_KEY = "obby.customCss.link";
const LINK_CACHE_KEY = "obby.customCss.linkCache";
const STYLE_ID = "obby-custom-css";
const LINK_STYLE_ID = "obby-custom-css-link";
export const MAX_CSS_CHARS = 5_000_000;

export type LinkStatus = "none" | "loading" | "ok" | "cached" | "error";

export interface CustomCssState {
  own: string;
  link: string;
  linkCss: string;
  linkStatus: LinkStatus;
}

// ---- sanitising -------------------------------------------------------------

// The browser's own preprocessing (CSS Syntax §3.3): CRLF, CR and FF become LF
// and NUL becomes U+FFFD, so we split the text exactly where the browser does.
function preprocess(css: string): string {
  return css.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�");
}

interface CssToken {
  kind:
    | "eof"
    | "text"
    | "open"
    | "close"
    | "semicolon"
    | "ident"
    | "at"
    | "function"
    | "url";
  raw: string;
  // lower-cased with escapes decoded, so "\75 RL" compares equal to "url"
  name?: string;
  // a url() we may keep as written
  safe?: boolean;
  // a refused url("...") whose arguments still run up to its ")"
  open?: boolean;
  // raw differs from the input because we closed a string or comment
  patched?: boolean;
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
// characters that are a token of their own wherever they stand
const PLAIN_RUN = /[ \n\t,:>+~*=!%&|^$?]+/y;
const NAME_RUN = /[A-Za-z0-9_\-\u0080-\uffff]+/y;
const NUMBER = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const COLON_NEXT = /[ \n\t]*:/y;
// Functions that take a bare string as an address: image-set("x"), src("x").
// Engines disagree on which characters above ASCII belong to a name, so we
// match the end of the name and one engine's "<nbsp>image-set(" is covered too.
const STRING_URL_FUNCTION = /(image-set|image|src)$/;
const IMPORT_RULE = /^import($|[\u0080-\uffff])/;

const isWhitespace = (c: string) => c === " " || c === "\n" || c === "\t";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isHexDigit = (c: string) =>
  isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isNameStart = (c: string) =>
  (c >= "a" && c <= "z") ||
  (c >= "A" && c <= "Z") ||
  c === "_" ||
  c >= "\u0080";
const isNameChar = (c: string) => isNameStart(c) || isDigit(c) || c === "-";
// a control character makes an unquoted url( malformed; tab and line break
// count as whitespace instead
const isNonPrintable = (c: string) =>
  c !== "" && c !== "\t" && c !== "\n" && (c < " " || c === "\u007f");

// The browser drops leading spaces and control characters before it reads the
// scheme, so we do the same before we look for "data:".
function isDataUrl(address: string): boolean {
  let start = 0;
  while (start < address.length && address.charAt(start) <= " ") start++;
  return address.slice(start, start + 5).toLowerCase() === "data:";
}

function closerOf(token: CssToken): string {
  if (token.kind === "open") return CLOSERS[token.raw] ?? "";
  if (token.kind === "function" || token.open) return ")";
  return "";
}

// Splits a stylesheet into tokens by the rules the browser uses (CSS Syntax
// §4), because an address can only be judged once we know whether its "url("
// sits in a string, in a comment or in real code.
class CssScanner {
  private readonly css: string;
  pos = 0;

  constructor(css: string) {
    this.css = css;
  }

  next(): CssToken {
    const css = this.css;
    const start = this.pos;
    if (start >= css.length) return { kind: "eof", raw: "" };
    const c = css.charAt(start);

    PLAIN_RUN.lastIndex = start;
    if (PLAIN_RUN.test(css)) {
      this.pos = PLAIN_RUN.lastIndex;
      return { kind: "text", raw: css.slice(start, this.pos) };
    }
    if (c === "/" && css.charAt(start + 1) === "*") {
      const end = css.indexOf("*/", start + 2);
      this.pos = end === -1 ? css.length : end + 2;
      const raw = css.slice(start, this.pos);
      // we close an open comment so that CSS joined on later starts outside it
      if (end !== -1) return { kind: "text", raw };
      return { kind: "text", raw: `${raw}*/`, patched: true };
    }
    if (c === '"' || c === "'") {
      const text = this.readString();
      return { kind: "text", raw: text.raw, patched: !text.closed };
    }
    // The browser reads "<!--" and "-->" as one token each, so a name that
    // follows them starts after them.
    if (css.startsWith("<!--", start) || css.startsWith("-->", start)) {
      this.pos = start + (c === "<" ? 4 : 3);
      return { kind: "text", raw: css.slice(start, this.pos) };
    }
    if (isDigit(c) || (c === "." && isDigit(css.charAt(start + 1)))) {
      NUMBER.lastIndex = start;
      NUMBER.test(css);
      this.pos = NUMBER.lastIndex;
      // a name right after a number is its unit, so "1url(" holds no address
      if (this.startsName(this.pos)) this.readName();
      return { kind: "text", raw: css.slice(start, this.pos) };
    }
    if (c === "#") {
      this.pos = start + 1;
      // a name right after "#" belongs to it, so "#url(" holds no address
      if (isNameChar(css.charAt(this.pos)) || this.validEscape(this.pos)) {
        this.readName();
      }
      return { kind: "text", raw: css.slice(start, this.pos) };
    }
    if (c === "@" && this.startsName(start + 1)) {
      this.pos = start + 1;
      const name = this.readName();
      return { kind: "at", raw: css.slice(start, this.pos), name };
    }
    if (this.startsName(start)) {
      const name = this.readName();
      if (css.charAt(this.pos) !== "(") {
        return { kind: "ident", raw: css.slice(start, this.pos), name };
      }
      this.pos++;
      if (name === "url") return this.readUrl(start, true);
      // We refuse every longer name that ends in "url", so an engine that
      // starts the name at a later character than we do still finds no address.
      if (name.endsWith("url")) return this.readUrl(start, false);
      return { kind: "function", raw: css.slice(start, this.pos), name };
    }
    this.pos = start + 1;
    if (c in CLOSERS) return { kind: "open", raw: c };
    if (c === ")" || c === "]" || c === "}") return { kind: "close", raw: c };
    if (c === ";") return { kind: "semicolon", raw: c };
    return { kind: "text", raw: c };
  }

  /** Drops everything up to the bracket that closes the current block. */
  skipBlock(closer: string): void {
    // a list instead of recursion, so deep nesting cannot exhaust the stack
    const pending = [closer];
    while (pending.length > 0) {
      const token = this.next();
      if (token.kind === "eof") return;
      if (token.kind === "close") {
        if (token.raw === pending[pending.length - 1]) pending.pop();
      } else {
        const inner = closerOf(token);
        if (inner) pending.push(inner);
      }
    }
  }

  /** Drops an at-rule: up to its ";", through its block, or to the end. */
  skipAtRule(): void {
    for (;;) {
      const before = this.pos;
      const token = this.next();
      if (token.kind === "eof" || token.kind === "semicolon") return;
      if (token.kind === "close" && token.raw === "}") {
        // this bracket closes the block around the rule, so it stays
        this.pos = before;
        return;
      }
      const closer = closerOf(token);
      if (closer) {
        this.skipBlock(closer);
        if (closer === "}") return;
      }
    }
  }

  followedByColon(): boolean {
    COLON_NEXT.lastIndex = this.pos;
    return COLON_NEXT.test(this.css);
  }

  nameFollows(): boolean {
    return isNameChar(this.css.charAt(this.pos)) || this.validEscape(this.pos);
  }

  private validEscape(at: number): boolean {
    return this.css.charAt(at) === "\\" && this.css.charAt(at + 1) !== "\n";
  }

  private startsName(at: number): boolean {
    const c = this.css.charAt(at);
    if (c === "-") {
      const d = this.css.charAt(at + 1);
      return d === "-" || isNameStart(d) || this.validEscape(at + 1);
    }
    return isNameStart(c) || this.validEscape(at);
  }

  private readEscape(): string {
    const css = this.css;
    this.pos++;
    if (this.pos >= css.length) return "�";
    let hex = "";
    while (hex.length < 6 && isHexDigit(css.charAt(this.pos))) {
      hex += css.charAt(this.pos++);
    }
    if (!hex) return css.charAt(this.pos++);
    if (isWhitespace(css.charAt(this.pos))) this.pos++;
    const code = Number.parseInt(hex, 16);
    const valid =
      code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : "�";
  }

  private readName(): string {
    const css = this.css;
    let name = "";
    for (;;) {
      NAME_RUN.lastIndex = this.pos;
      if (NAME_RUN.test(css)) {
        name += css.slice(this.pos, NAME_RUN.lastIndex);
        this.pos = NAME_RUN.lastIndex;
      } else if (this.validEscape(this.pos)) {
        name += this.readEscape();
      } else {
        return name.toLowerCase();
      }
    }
  }

  private readString(): { raw: string; value: string; closed: boolean } {
    const css = this.css;
    const start = this.pos;
    const quote = css.charAt(start);
    let value = "";
    this.pos++;
    while (this.pos < css.length) {
      const c = css.charAt(this.pos);
      if (c === quote) {
        this.pos++;
        return { raw: css.slice(start, this.pos), value, closed: true };
      }
      // a raw line break ends the string and the browser reads on from there
      if (c === "\n") {
        return { raw: css.slice(start, this.pos), value, closed: false };
      }
      if (c !== "\\") {
        value += c;
        this.pos++;
      } else if (this.pos + 1 >= css.length) {
        // we leave out a final backslash, which would escape the quote we add
        const raw = css.slice(start, this.pos) + quote;
        this.pos++;
        return { raw, value, closed: false };
      } else if (css.charAt(this.pos + 1) === "\n") {
        this.pos += 2;
      } else {
        value += this.readEscape();
      }
    }
    // we close an open string so that CSS joined on later starts outside it
    return { raw: css.slice(start) + quote, value, closed: false };
  }

  // Called just after "url(". A quoted address makes an ordinary function, an
  // unquoted one is a single token that runs to the next ")".
  private readUrl(start: number, mayKeep: boolean): CssToken {
    const css = this.css;
    const refused: CssToken = { kind: "url", raw: "", safe: false };
    this.skipWhitespace();
    const first = css.charAt(this.pos);
    if (first === '"' || first === "'") {
      const address = this.readString();
      if (mayKeep && address.closed && isDataUrl(address.value)) {
        return { kind: "function", raw: css.slice(start, this.pos), name: "" };
      }
      return { ...refused, open: true };
    }
    let value = "";
    for (;;) {
      const c = css.charAt(this.pos);
      if (c === "") return refused;
      if (isWhitespace(c)) {
        this.skipWhitespace();
        if (this.pos >= css.length) return refused;
        if (css.charAt(this.pos) !== ")") break;
      }
      if (css.charAt(this.pos) === ")") {
        this.pos++;
        const raw = css.slice(start, this.pos);
        return { kind: "url", raw, safe: mayKeep && isDataUrl(value) };
      }
      if (c === '"' || c === "'" || c === "(" || isNonPrintable(c)) break;
      if (c === "\\") {
        if (!this.validEscape(this.pos)) break;
        value += this.readEscape();
      } else {
        value += c;
        this.pos++;
      }
    }
    // the browser discards a malformed url( up to the next unescaped ")"
    while (this.pos < css.length) {
      if (this.validEscape(this.pos)) {
        this.readEscape();
      } else if (css.charAt(this.pos++) === ")") {
        break;
      }
    }
    return refused;
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.css.charAt(this.pos))) this.pos++;
  }
}

export function sanitizeCss(input: string): string {
  const css = preprocess(input);
  const scanner = new CssScanner(css);
  const out: string[] = [];
  // We copy the input in long stretches between the few places we rewrite,
  // which keeps a large stylesheet fast.
  let copied = 0;
  for (;;) {
    const at = scanner.pos;
    const token = scanner.next();
    if (token.kind === "eof") break;
    let replacement: string | undefined;
    if (token.kind === "at" && IMPORT_RULE.test(token.name ?? "")) {
      // @import pulls in another (remote) stylesheet. We leave a space in its
      // place so the text on either side cannot join into a new name.
      scanner.skipAtRule();
      replacement = " ";
    } else if (token.kind === "url") {
      // only inline data: URLs may be referenced
      if (!token.safe) {
        if (token.open) scanner.skipBlock(")");
        // a space keeps the text that follows from growing our word into a name
        replacement = scanner.nameFollows() ? "none " : "none";
      }
    } else if (token.kind === "function") {
      const name = token.name ?? "";
      if (STRING_URL_FUNCTION.test(name)) replacement = "invalid-url-fn(";
      // legacy script hook
      else if (name === "expression") replacement = "invalid(";
    } else if (token.kind === "ident") {
      // legacy binding hooks
      if (
        token.name === "-moz-binding" ||
        (token.name === "behavior" && scanner.followedByColon())
      ) {
        replacement = "invalid";
      }
    } else if (token.patched) {
      replacement = token.raw;
    }
    if (replacement !== undefined) {
      out.push(css.slice(copied, at), replacement);
      copied = scanner.pos;
    }
  }
  out.push(css.slice(copied));
  // closing the <style> element would let the rest escape as markup
  return out.join("").replace(/<\/style/gi, "<\\/style");
}

export function isValidCssLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// ---- store ------------------------------------------------------------------

let state: CustomCssState = {
  own: "",
  link: "",
  linkCss: "",
  linkStatus: "none",
};
const listeners = new Set<() => void>();

function storageGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // quota or storage disabled: still applies for this session
  }
}

function applyToDocument(id: string, css: string): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css.trim()) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    // last in <head> so it overrides the app's own styles, with the linked
    // file ahead of the user's own CSS so the own rules win
    const own = id === LINK_STYLE_ID ? document.getElementById(STYLE_ID) : null;
    document.head.insertBefore(el, own);
  }
  if (el.textContent !== css) el.textContent = css;
}

function update(patch: Partial<CustomCssState>): void {
  state = { ...state, ...patch };
  // Each source gets a <style> element of its own, so a block the linked
  // file leaves open ends with that file and the user's own CSS still applies.
  applyToDocument(LINK_STYLE_ID, state.linkCss);
  applyToDocument(STYLE_ID, state.own);
  for (const l of listeners) l();
}

async function fetchLink(link: string): Promise<string> {
  const res = await fetch(link, {
    cache: "no-cache",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CSS_CHARS) throw new Error("too-large");
  // a file host's preview page instead of the raw file
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("not-css");
  return sanitizeCss(text);
}

let refreshSeq = 0;
async function refreshLink(): Promise<void> {
  const link = state.link;
  if (!link) return;
  const seq = ++refreshSeq;
  update({ linkStatus: state.linkCss ? "cached" : "loading" });
  try {
    const css = await fetchLink(link);
    if (seq !== refreshSeq) return;
    storageSet(LINK_CACHE_KEY, css);
    update({ linkCss: css, linkStatus: "ok" });
  } catch {
    if (seq !== refreshSeq) return;
    update({ linkStatus: state.linkCss ? "cached" : "error" });
  }
}

let loaded = false;
export function loadCustomCss(): void {
  if (loaded) return;
  loaded = true;
  const link = storageGet(LINK_KEY);
  update({
    own: sanitizeCss(storageGet(OWN_KEY)),
    link,
    linkCss: link ? sanitizeCss(storageGet(LINK_CACHE_KEY)) : "",
    linkStatus: link ? "cached" : "none",
  });
  void refreshLink();
}

/** Saves (or, with "", removes) the user's own pasted/uploaded CSS. */
export function saveOwnCss(input: string): void {
  if (input.length > MAX_CSS_CHARS) throw new Error("too-large");
  const own = sanitizeCss(input);
  storageSet(OWN_KEY, own);
  update({ own });
}

/**
 * Sets (or, with "", removes) the linked stylesheet and loads it. Resolves
 * once the first fetch has finished; check `linkStatus` for the outcome.
 */
export async function setCssLink(input: string): Promise<void> {
  const link = input.trim();
  if (link && !isValidCssLink(link)) throw new Error("bad-link");
  storageSet(LINK_KEY, link);
  storageSet(LINK_CACHE_KEY, "");
  refreshSeq++;
  update({ link, linkCss: "", linkStatus: link ? "loading" : "none" });
  await refreshLink();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCustomCssState(): CustomCssState {
  return state;
}

export function useCustomCssState(): CustomCssState {
  return useSyncExternalStore(subscribe, getCustomCssState);
}

// test hook
export function resetCustomCssForTests(): void {
  loaded = false;
  refreshSeq++;
  state = { own: "", link: "", linkCss: "", linkStatus: "none" };
  applyToDocument(LINK_STYLE_ID, "");
  applyToDocument(STYLE_ID, "");
}
