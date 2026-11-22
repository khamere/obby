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
    | "string"
    | "open"
    | "close"
    | "semicolon"
    | "ident"
    | "at"
    | "function"
    | "url";
  // the bracket itself, for an "open" or "close" token
  raw?: string;
  // lower-cased with escapes decoded, so "\75 RL" compares equal to "url"
  name?: string;
  // a url() we may keep as written
  safe?: boolean;
  // a refused url("...") whose arguments still run up to its ")"
  open?: boolean;
  // a string that ends at its own closing quote
  closed?: boolean;
  // the text that replaces a string or comment the stylesheet leaves open
  patch?: string;
  // another engine may start a new token right after this one
  split?: boolean;
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
// characters that are a token of their own wherever they stand
const PLAIN_RUN = /[ \n\t,:>+~*=!%&|^$?]+/y;
const ASCII_NAME_RUN = /[A-Za-z0-9_-]+/y;
const HIGH_NAME_RUN = /[\u0080-\uffff]+/y;
const DOUBLE_QUOTED_RUN = /[^"\\\n]+/y;
const SINGLE_QUOTED_RUN = /[^'\\\n]+/y;
// everything an unquoted address may hold as written: no space, quote, bracket, backslash or control character
const UNQUOTED_URL_RUN = /[!#-&*-[\]-~\u0080-\uffff]+/y;
const NUMBER = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
// The functions that read a bare string as an address are image() and image-set() (CSS Images 4) and src() (CSS Values 5).
const STRING_URL_FUNCTION = /^(?:-[a-z]+-)?(?:image-set|image|src)$/;
const IMAGE_LIST_FUNCTION = /^(?:-[a-z]+-)?(?:image-set|image)$/;
const STRING_ONLY_FUNCTION = /^(?:-[a-z]+-)?src$/;
const IMAGE_ARGUMENT_FUNCTION =
  /^(?:type|invalid-url-fn|(?:-[a-z]+-)?(?:repeating-)?(?:linear|radial|conic)-gradient)$/;
const REFUSED_FUNCTION = "invalid-url-fn(";
const IMPORT_RULE = /^import($|[\u0080-\uffff])/;
// An empty comment keeps the text on both sides apart, where a space could be swallowed by a hex escape before it.
const SEPARATOR = "/**/";

const TEXT: CssToken = { kind: "text" };
const SPLIT: CssToken = { kind: "text", split: true };
const END: CssToken = { kind: "eof" };
const CLOSED_STRING: CssToken = { kind: "string", closed: true };
const BROKEN_STRING: CssToken = { kind: "string" };
const KEPT_URL: CssToken = { kind: "url", safe: true };
const REFUSED_URL: CssToken = { kind: "url" };
const REFUSED_OPEN_URL: CssToken = { kind: "url", open: true };
const KEPT_QUOTED_URL: CssToken = { kind: "function" };
const PUNCTUATION: Record<string, CssToken> = {
  "(": { kind: "open", raw: "(" },
  "[": { kind: "open", raw: "[" },
  "{": { kind: "open", raw: "{" },
  ")": { kind: "close", raw: ")" },
  "]": { kind: "close", raw: "]" },
  "}": { kind: "close", raw: "}" },
  ";": { kind: "semicolon" },
};

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
const takesAddress = (name: string) =>
  name === "url" || STRING_URL_FUNCTION.test(name);

function closerOf(token: CssToken): string {
  if (token.kind === "open") return CLOSERS[token.raw ?? ""] ?? "";
  if (token.kind === "function" || token.open) return ")";
  return "";
}

// Splits a stylesheet into tokens by the rules the browser uses (CSS Syntax
// §4), because an address can only be judged once we know whether its "url("
// sits in a string, in a comment or in real code.
class CssScanner {
  private readonly css: string;
  pos = 0;
  // where the name we read last continues after its last character above ASCII
  private tailAt = -1;
  private tailName = "";
  private danglingEscape = false;
  // the text of the address in the url( we read last, when it is well formed
  private addressFrom = -1;
  private addressTo = -1;

  constructor(css: string) {
    this.css = css;
  }

  next(): CssToken {
    const css = this.css;
    const start = this.pos;
    if (start >= css.length) return END;
    this.tailAt = -1;

    PLAIN_RUN.lastIndex = start;
    if (PLAIN_RUN.test(css)) {
      this.pos = PLAIN_RUN.lastIndex;
      return TEXT;
    }
    const c = css.charAt(start);
    if (c === "/" && css.charAt(start + 1) === "*") {
      const end = css.indexOf("*/", start + 2);
      if (end !== -1) {
        this.pos = end + 2;
        return TEXT;
      }
      this.pos = css.length;
      // we close an open comment so that the stylesheet ends outside it
      return { kind: "text", patch: `${css.slice(start)}*/` };
    }
    if (c === '"' || c === "'") {
      if (this.skipString()) return CLOSED_STRING;
      if (this.pos < css.length) return BROKEN_STRING;
      // we leave out a final backslash, which would escape the quote we add
      const end = this.danglingEscape ? css.length - 1 : css.length;
      return { kind: "string", patch: css.slice(start, end) + c };
    }
    // The browser reads "<!--" and "-->" as one token each, so a name that
    // follows them starts after them.
    if (css.startsWith("<!--", start) || css.startsWith("-->", start)) {
      this.pos = start + (c === "<" ? 4 : 3);
      return TEXT;
    }
    if (isDigit(c) || (c === "." && isDigit(css.charAt(start + 1)))) {
      NUMBER.lastIndex = start;
      NUMBER.test(css);
      this.pos = NUMBER.lastIndex;
      // a name right after a number is its unit, so "1url(" holds no address
      if (this.startsName(this.pos)) this.readName();
      return this.splitAfterName(-1) ?? TEXT;
    }
    if (c === "#") {
      this.pos = start + 1;
      // a name right after "#" belongs to it, so "#url(" holds no address
      if (isNameChar(css.charAt(this.pos)) || this.validEscape(this.pos)) {
        this.readName();
      }
      return this.splitAfterName(-1) ?? TEXT;
    }
    if (c === "@" && this.startsName(start + 1)) {
      this.pos = start + 1;
      const name = this.readName();
      if (IMPORT_RULE.test(name)) return { kind: "at", name };
      return this.splitAfterName(-1) ?? { kind: "at", name };
    }
    if (this.startsName(start)) {
      const name = this.readName();
      const split = this.splitAfterName(start);
      if (split) return split;
      if (css.charAt(this.pos) !== "(") return { kind: "ident", name };
      this.pos++;
      if (name === "url") return this.readUrl();
      return { kind: "function", name };
    }
    this.pos = start + 1;
    return PUNCTUATION[c] ?? TEXT;
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

  /** The refused address we just read as a plain string, which names it and fetches nothing. */
  refusedAddressAsString(token: CssToken): string | undefined {
    if (this.addressFrom === -1) return undefined;
    const css = this.css;
    const raw = css.slice(this.addressFrom, this.addressTo);
    if (!token.open) return raw.includes("\\") ? undefined : `"${raw}"`;
    const after = this.pos;
    this.skipWhitespace();
    if (css.charAt(this.pos) === ")") {
      this.pos++;
      return raw;
    }
    this.pos = after;
    return undefined;
  }

  /** Whether a word we write here would grow into a longer name or a function. */
  joinsNext(): boolean {
    const c = this.css.charAt(this.pos);
    return isNameChar(c) || c === "(" || this.validEscape(this.pos);
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
    let tailFrom = 0;
    this.tailAt = -1;
    ASCII_NAME_RUN.lastIndex = this.pos;
    if (ASCII_NAME_RUN.test(css)) {
      name = css.slice(this.pos, ASCII_NAME_RUN.lastIndex);
      this.pos = ASCII_NAME_RUN.lastIndex;
      const next = css.charCodeAt(this.pos);
      // most names are plain ASCII, and those we can hand back without a second look
      if (next !== 0x5c && !(next >= 0x80)) return name.toLowerCase();
    }
    for (;;) {
      ASCII_NAME_RUN.lastIndex = this.pos;
      HIGH_NAME_RUN.lastIndex = this.pos;
      if (ASCII_NAME_RUN.test(css)) {
        name += css.slice(this.pos, ASCII_NAME_RUN.lastIndex);
        this.pos = ASCII_NAME_RUN.lastIndex;
      } else if (HIGH_NAME_RUN.test(css)) {
        name += css.slice(this.pos, HIGH_NAME_RUN.lastIndex);
        this.pos = HIGH_NAME_RUN.lastIndex;
        this.tailAt = this.pos;
        tailFrom = name.length;
      } else if (this.validEscape(this.pos)) {
        name += this.readEscape();
      } else {
        this.tailName = name.slice(tailFrom).toLowerCase();
        return name.toLowerCase();
      }
    }
  }

  // Engines disagree on which characters above ASCII belong to a name and on unicode-range tokens, so we look for a URL function that one of them would start inside or right after the name.
  private splitAfterName(nameStart: number): CssToken | undefined {
    const css = this.css;
    const tail = this.tailAt;
    if (tail !== -1 && tail !== this.pos && css.charAt(this.pos) === "(") {
      // After a number, "#" or "@" we read a bracket here where that engine reads a function, so there every name counts.
      const anyName = nameStart === -1 && this.startsName(tail);
      if (anyName || takesAddress(this.tailName)) {
        this.pos = tail;
        return SPLIT;
      }
    }
    const u = this.pos - 1;
    if ((u === nameStart || u === tail) && "uU".includes(css.charAt(u))) {
      const end = this.unicodeRangeEnd(u);
      if (end === -1) return undefined;
      this.pos = end;
      return this.functionFollows() ? SPLIT : TEXT;
    }
    return undefined;
  }

  // A function right after a unicode range is a unit and a bracket to engines without such tokens.
  private functionFollows(): boolean {
    const from = this.pos;
    if (!this.startsName(from)) return false;
    this.readName();
    const found = this.css.charAt(this.pos) === "(";
    this.pos = from;
    return found;
  }

  // Some engines read "u+" followed by hex digits or "?" as a unicode-range token of at most six characters and a second part after "-".
  private unicodeRangeEnd(at: number): number {
    const css = this.css;
    if (css.charAt(at + 1) !== "+") return -1;
    let end = at + 2;
    const limit = end + 6;
    while (end < limit && isHexDigit(css.charAt(end))) end++;
    const digitsEnd = end;
    while (end < limit && css.charAt(end) === "?") end++;
    if (end === at + 2) return -1;
    if (end !== digitsEnd) return end;
    if (css.charAt(end) === "-" && isHexDigit(css.charAt(end + 1))) {
      const secondLimit = end + 7;
      end++;
      while (end < secondLimit && isHexDigit(css.charAt(end))) end++;
    }
    return end;
  }

  /** Moves past a string without copying it and tells whether its closing quote was there. */
  private skipString(): boolean {
    const css = this.css;
    const quote = css.charAt(this.pos);
    const run = quote === '"' ? DOUBLE_QUOTED_RUN : SINGLE_QUOTED_RUN;
    this.danglingEscape = false;
    this.pos++;
    for (;;) {
      run.lastIndex = this.pos;
      if (run.test(css)) this.pos = run.lastIndex;
      const c = css.charAt(this.pos);
      if (c === quote) {
        this.pos++;
        return true;
      }
      // a raw line break ends the string and the browser reads on from there
      if (c === "" || c === "\n") return false;
      if (this.pos + 1 >= css.length) {
        this.danglingEscape = true;
        this.pos++;
      } else if (css.charAt(this.pos + 1) === "\n") {
        this.pos += 2;
      } else {
        this.readEscape();
      }
    }
  }

  // We decode only the start of an address, which is all it takes to tell an inline data: address from one the browser would fetch.
  private startsWithData(from: number): boolean {
    const css = this.css;
    const end = this.pos;
    let scheme = "";
    this.pos = from;
    while (scheme.length < 5 && this.pos < end) {
      let c = css.charAt(this.pos);
      if (c !== "\\") {
        this.pos++;
      } else if (css.charAt(this.pos + 1) === "\n") {
        this.pos += 2;
        continue;
      } else {
        c = this.readEscape();
      }
      // the browser drops leading spaces and control characters before it reads the scheme
      if (scheme || c > " ") scheme += c;
    }
    this.pos = end;
    return scheme.toLowerCase() === "data:";
  }

  // Called just after "url(". A quoted address makes an ordinary function, an
  // unquoted one is a single token that runs to the next ")".
  private readUrl(): CssToken {
    const css = this.css;
    this.skipWhitespace();
    const from = this.pos;
    const first = css.charAt(from);
    this.addressFrom = -1;
    if (first === '"' || first === "'") {
      if (!this.skipString()) return REFUSED_OPEN_URL;
      this.addressFrom = from;
      this.addressTo = this.pos;
      return this.startsWithData(from + 1) ? KEPT_QUOTED_URL : REFUSED_OPEN_URL;
    }
    let contentEnd = from;
    for (;;) {
      UNQUOTED_URL_RUN.lastIndex = this.pos;
      if (UNQUOTED_URL_RUN.test(css)) this.pos = UNQUOTED_URL_RUN.lastIndex;
      contentEnd = this.pos;
      const c = css.charAt(this.pos);
      if (c === "") return REFUSED_URL;
      if (isWhitespace(c)) {
        this.skipWhitespace();
        if (this.pos >= css.length) return REFUSED_URL;
        if (css.charAt(this.pos) !== ")") break;
      }
      if (css.charAt(this.pos) === ")") {
        this.pos++;
        this.addressFrom = from;
        this.addressTo = contentEnd;
        return this.startsWithData(from) ? KEPT_URL : REFUSED_URL;
      }
      // a quote, "(", control character or broken escape makes the address malformed
      if (!this.validEscape(this.pos)) break;
      this.readEscape();
    }
    // the browser discards a malformed url( up to the next unescaped ")"
    while (this.pos < css.length) {
      if (this.validEscape(this.pos)) {
        this.readEscape();
      } else if (css.charAt(this.pos++) === ")") {
        break;
      }
    }
    return REFUSED_URL;
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.css.charAt(this.pos))) this.pos++;
  }
}

// One reading of the stylesheet: the rewritten text, and how many places held something we refuse.
function rewrite(css: string): { text: string; refused: number } {
  const scanner = new CssScanner(css);
  const out: string[] = [];
  let refused = 0;
  // the brackets we are inside, innermost last, each by the character that closes it
  const inside: string[] = [];
  // for each of them, whether a string written straight into it would be read as an address
  const readsStrings: boolean[] = [];
  const enter = (closer: string, strings: boolean) => {
    inside.push(closer);
    readsStrings.push(strings);
  };
  let inNamespaceRule = false;
  // We copy the input in long stretches between the few places we rewrite,
  // which keeps a large stylesheet fast.
  let copied = 0;
  for (;;) {
    const at = scanner.pos;
    const token = scanner.next();
    if (token.kind === "eof") break;
    let from = at;
    let replacement = token.patch;
    if (token.split) {
      from = scanner.pos;
      replacement = SEPARATOR;
    } else if (token.kind === "at") {
      inNamespaceRule = token.name === "namespace" && inside.length === 0;
      if (IMPORT_RULE.test(token.name ?? "")) {
        // @import pulls in another (remote) stylesheet
        scanner.skipAtRule();
        replacement = SEPARATOR;
      }
    } else if (token.kind === "url") {
      // only inline data: URLs may be referenced
      if (!token.safe) {
        // A namespace is named by its address and never fetched, so there we keep the name as a string.
        if (inNamespaceRule)
          replacement = scanner.refusedAddressAsString(token);
        if (replacement === undefined) {
          if (token.open) scanner.skipBlock(")");
          replacement = scanner.joinsNext() ? "none " : "none";
        }
      }
    } else if (token.kind === "function") {
      inNamespaceRule = false;
      const name = token.name;
      if (name === undefined) {
        enter(")", false);
      } else if (STRING_ONLY_FUNCTION.test(name)) {
        replacement = REFUSED_FUNCTION;
        enter(")", false);
      } else if (IMAGE_LIST_FUNCTION.test(name)) {
        enter(")", true);
      } else {
        // var() and its kind could put a string here after we have looked, so only functions that draw an image themselves stay.
        if (
          readsStrings[readsStrings.length - 1] === true &&
          !IMAGE_ARGUMENT_FUNCTION.test(name)
        ) {
          replacement = REFUSED_FUNCTION;
        }
        enter(")", false);
      }
    } else if (token.kind === "string") {
      if (readsStrings[readsStrings.length - 1] === true) {
        replacement = scanner.joinsNext() ? "none " : "none";
      }
    } else if (token.kind === "open") {
      inNamespaceRule = false;
      enter(
        CLOSERS[token.raw ?? ""],
        readsStrings[readsStrings.length - 1] === true,
      );
    } else if (token.kind === "close") {
      inNamespaceRule = false;
      if (token.raw === inside[inside.length - 1]) {
        inside.pop();
        readsStrings.pop();
      }
    } else if (token.kind === "semicolon") {
      inNamespaceRule = false;
    }
    if (replacement !== undefined) {
      if (replacement !== token.patch) refused++;
      out.push(css.slice(copied, from), replacement);
      copied = scanner.pos;
    }
  }
  if (out.length === 0) return { text: css, refused };
  out.push(css.slice(copied));
  return { text: out.join(""), refused };
}

const refusedIn = (css: string) => rewrite(css).refused;
let secondReading = refusedIn;

export function sanitizeCss(input: string): string {
  // Closing the <style> element would let the rest escape as markup, and we escape it before we read so that we judge the text we hand out.
  const css = preprocess(input).replace(/<\/style/gi, "<\\/style");
  const out = rewrite(css).text;
  // Text we changed can read differently from the text we judged, so we read it once more and apply nothing if it still holds anything we refuse.
  if (out !== css && secondReading(out) > 0) return "";
  return out;
}

// An empty result for a stylesheet that holds something means we refused it as a whole.
function sanitizeOrThrow(input: string): string {
  const css = sanitizeCss(input);
  if (!css.trim() && input.trim()) throw new Error("refused");
  return css;
}

const IGNORED_BETWEEN_RULES = /^(?:[ \n\t]+|\/\*[\s\S]*\*\/|<!--|-->)$/;

// The start of a stylesheet, where layer statements may come first and namespaces may follow them.
function readPrelude(css: string): { prefixes: string[]; layersEnd: number } {
  const scanner = new CssScanner(css);
  const prefixes: string[] = [];
  let layersEnd = 0;
  let sawNamespace = false;
  const read = () => {
    const at = scanner.pos;
    const token = scanner.next();
    return { token, raw: css.slice(at, scanner.pos) };
  };
  const readPastSpace = () => {
    let part = read();
    while (IGNORED_BETWEEN_RULES.test(part.raw)) part = read();
    return part;
  };
  // an address is a string, or an inline url() that we kept as written
  const readAddress = (part: ReturnType<typeof read>) => {
    if (part.token.closed || part.token.safe) return part.raw;
    if (part.token.kind !== "function" || part.token.name !== undefined) {
      return undefined;
    }
    const end = readPastSpace();
    return end.token.raw === ")" ? `${part.raw})` : undefined;
  };
  for (;;) {
    const rule = readPastSpace();
    if (rule.token.kind !== "at") break;
    if (rule.token.name === "namespace") {
      const first = readPastSpace();
      const named = first.token.kind === "ident";
      const address = readAddress(named ? readPastSpace() : first);
      if (address === undefined) break;
      if (readPastSpace().token.kind !== "semicolon") break;
      sawNamespace = true;
      // a default namespace would change which elements the user's own selectors match
      if (named)
        prefixes.push(`@namespace ${first.raw}${SEPARATOR}${address};`);
    } else if (
      // the browser ignores a namespace that comes after a layer statement which itself follows a namespace
      !sawNamespace &&
      (rule.token.name === "charset" || rule.token.name === "layer")
    ) {
      scanner.skipAtRule();
      // a rule with a block ends the part of a stylesheet where namespaces may be declared
      if (css.charAt(scanner.pos - 1) !== ";") break;
      layersEnd = scanner.pos;
    } else {
      break;
    }
  }
  return { prefixes, layersEnd };
}

// The user's own CSS is a stylesheet of its own, so we repeat the namespace prefixes the linked one declares and selectors such as svg|path keep matching.
export function namespacePrefixRules(css: string): string {
  return readPrelude(css).prefixes.join("\n");
}

/** The user's own CSS with the linked stylesheet's namespace prefixes, placed where the browser accepts them and the user's own ones still come last. */
export function withLinkedPrefixes(own: string, linkCss: string): string {
  if (!own.trim()) return own;
  const prefixes = namespacePrefixRules(linkCss);
  if (!prefixes) return own;
  const at = readPrelude(own).layersEnd;
  return at === 0
    ? `${prefixes}\n${own}`
    : `${own.slice(0, at)}\n${prefixes}\n${own.slice(at)}`;
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

// Returns "" when the value is stored, and otherwise whether storage is full or closed to us.
function storageSet(
  key: string,
  value: string,
): "" | "not-stored" | "no-storage" {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return "";
  } catch (error) {
    const full =
      error instanceof DOMException &&
      (error.name === "QuotaExceededError" ||
        error.name === "NS_ERROR_DOM_QUOTA_REACHED");
    return full ? "not-stored" : "no-storage";
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
  applyToDocument(STYLE_ID, withLinkedPrefixes(state.own, state.linkCss));
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
  return sanitizeOrThrow(text);
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
    // the copy only bridges the next start, so the stylesheet still applies when storage has no room for it
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
  // a blank stylesheet is a removal, which has to work when storage is full
  const own = input.trim() ? sanitizeOrThrow(input) : "";
  // CSS we cannot keep would be gone at the next start, so we apply it only once it is stored
  const failure = storageSet(OWN_KEY, own);
  if (failure) throw new Error(failure);
  update({ own });
}

/**
 * Sets (or, with "", removes) the linked stylesheet and loads it. Resolves
 * once the first fetch has finished; check `linkStatus` for the outcome.
 */
export async function setCssLink(input: string): Promise<void> {
  const link = input.trim();
  if (link && !isValidCssLink(link)) throw new Error("bad-link");
  const failure = storageSet(LINK_KEY, link);
  if (failure) throw new Error(failure);
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

// test hook: stands in for the second reading, which no known stylesheet fails
export function setSecondReadingForTests(
  read: (css: string) => number = refusedIn,
): void {
  secondReading = read;
}

// test hook
export function resetCustomCssForTests(): void {
  secondReading = refusedIn;
  loaded = false;
  refreshSeq++;
  state = { own: "", link: "", linkCss: "", linkStatus: "none" };
  applyToDocument(LINK_STYLE_ID, "");
  applyToDocument(STYLE_ID, "");
}
