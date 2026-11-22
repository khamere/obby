// A second, separate reading of CSS Syntax Level 3 §4, so the tests judge the
// sanitiser's output by the tokens a browser would see in it.

export interface Engine {
  // older tokenisers read "u+26" as one unicode-range token
  unicodeRange: boolean;
  // newer tokenisers keep characters such as U+00A0 and U+2028 out of names
  everyNonAsciiInNames: boolean;
}

export const ENGINES: Engine[] = [
  { unicodeRange: false, everyNonAsciiInNames: true },
  { unicodeRange: false, everyNonAsciiInNames: false },
  { unicodeRange: true, everyNonAsciiInNames: true },
  { unicodeRange: true, everyNonAsciiInNames: false },
];

export interface Token {
  type:
    | "whitespace"
    | "string"
    | "bad-string"
    | "hash"
    | "delim"
    | "number"
    | "cdo"
    | "cdc"
    | "at-keyword"
    | "ident"
    | "function"
    | "url"
    | "bad-url"
    | "unicode-range";
  value: string;
}

const EOF = -1;
const NAME_RANGES: [number, number][] = [
  [0xb7, 0xb7],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x203f, 0x2040],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
  [0x10000, 0x10ffff],
];

const code = (c: string) => c.codePointAt(0) ?? EOF;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) =>
  isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isWhitespace = (c: number) => c === 0x0a || c === 0x09 || c === 0x20;
const isNonPrintable = (c: number) =>
  (c >= 0 && c <= 8) || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;

export function tokenize(input: string, engine: Engine): Token[] {
  const text = input.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�");
  const cps = Array.from(text, code);
  const tokens: Token[] = [];
  let pos = 0;

  const at = (offset = 0) =>
    pos + offset < cps.length ? cps[pos + offset] : EOF;
  const isNameStart = (c: number) => {
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f) {
      return true;
    }
    if (c < 0x80) return false;
    if (engine.everyNonAsciiInNames) return true;
    return NAME_RANGES.some(([low, high]) => c >= low && c <= high);
  };
  const isName = (c: number) => isNameStart(c) || isDigit(c) || c === 0x2d;
  const validEscape = (offset = 0) =>
    at(offset) === 0x5c && at(offset + 1) !== 0x0a;
  const startsIdent = (offset = 0) => {
    const c = at(offset);
    if (c === 0x2d) {
      return (
        isNameStart(at(offset + 1)) ||
        at(offset + 1) === 0x2d ||
        validEscape(offset + 1)
      );
    }
    return isNameStart(c) || validEscape(offset);
  };
  const startsNumber = (offset = 0) => {
    let c = at(offset);
    let next = offset + 1;
    if (c === 0x2b || c === 0x2d) {
      c = at(next);
      next++;
    }
    return isDigit(c) || (c === 0x2e && isDigit(at(next)));
  };
  // called with the backslash already consumed
  const consumeEscape = (): string => {
    const c = at();
    if (c === EOF) return "�";
    pos++;
    if (!isHex(c)) return String.fromCodePoint(c);
    let hex = String.fromCodePoint(c);
    while (hex.length < 6 && isHex(at()))
      hex += String.fromCodePoint(cps[pos++]);
    if (isWhitespace(at())) pos++;
    const value = Number.parseInt(hex, 16);
    const bad =
      value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff);
    return bad ? "�" : String.fromCodePoint(value);
  };
  const consumeName = (): string => {
    let name = "";
    for (;;) {
      if (isName(at())) name += String.fromCodePoint(cps[pos++]);
      else if (validEscape()) {
        pos++;
        name += consumeEscape();
      } else return name;
    }
  };
  const consumeNumber = () => {
    if (at() === 0x2b || at() === 0x2d) pos++;
    while (isDigit(at())) pos++;
    if (at() === 0x2e && isDigit(at(1))) {
      pos += 2;
      while (isDigit(at())) pos++;
    }
    const sign = at(1) === 0x2b || at(1) === 0x2d ? 1 : 0;
    if ((at() === 0x45 || at() === 0x65) && isDigit(at(1 + sign))) {
      pos += 2 + sign;
      while (isDigit(at())) pos++;
    }
  };
  const consumeNumeric = (): Token => {
    consumeNumber();
    if (startsIdent()) consumeName();
    else if (at() === 0x25) pos++;
    return { type: "number", value: "" };
  };
  const consumeString = (quote: number): Token => {
    let value = "";
    for (;;) {
      const c = at();
      if (c === EOF) return { type: "string", value };
      pos++;
      if (c === quote) return { type: "string", value };
      if (c === 0x0a) {
        pos--;
        return { type: "bad-string", value };
      }
      if (c !== 0x5c) value += String.fromCodePoint(c);
      else if (at() === EOF) continue;
      else if (at() === 0x0a) pos++;
      else value += consumeEscape();
    }
  };
  const consumeBadUrl = (): Token => {
    for (;;) {
      const c = at();
      if (c === EOF) break;
      if (validEscape()) {
        pos++;
        consumeEscape();
        continue;
      }
      pos++;
      if (c === 0x29) break;
    }
    return { type: "bad-url", value: "" };
  };
  const consumeUrl = (): Token => {
    let value = "";
    while (isWhitespace(at())) pos++;
    for (;;) {
      const c = at();
      if (c === EOF) return { type: "url", value };
      if (c === 0x29) {
        pos++;
        return { type: "url", value };
      }
      if (isWhitespace(c)) {
        while (isWhitespace(at())) pos++;
        if (at() === EOF) return { type: "url", value };
        if (at() === 0x29) {
          pos++;
          return { type: "url", value };
        }
        return consumeBadUrl();
      }
      if (c === 0x22 || c === 0x27 || c === 0x28 || isNonPrintable(c)) {
        return consumeBadUrl();
      }
      if (c === 0x5c) {
        if (!validEscape()) return consumeBadUrl();
        pos++;
        value += consumeEscape();
      } else {
        pos++;
        value += String.fromCodePoint(c);
      }
    }
  };
  const consumeIdentLike = (): Token => {
    const name = consumeName();
    if (at() !== 0x28) return { type: "ident", value: name };
    pos++;
    if (name.toLowerCase() !== "url") return { type: "function", value: name };
    while (isWhitespace(at()) && isWhitespace(at(1))) pos++;
    const quoted = (c: number) => c === 0x22 || c === 0x27;
    if (quoted(at()) || (isWhitespace(at()) && quoted(at(1)))) {
      return { type: "function", value: name };
    }
    return consumeUrl();
  };
  const consumeUnicodeRange = (): Token => {
    const from = pos;
    pos += 2;
    let length = 0;
    while (length < 6 && isHex(at())) {
      pos++;
      length++;
    }
    const digits = length;
    while (length < 6 && at() === 0x3f) {
      pos++;
      length++;
    }
    if (length === digits && at() === 0x2d && isHex(at(1))) {
      pos++;
      for (let n = 0; n < 6 && isHex(at()); n++) pos++;
    }
    return {
      type: "unicode-range",
      value: String.fromCodePoint(...cps.slice(from, pos)),
    };
  };

  const consumeToken = (): Token | null => {
    while (at() === 0x2f && at(1) === 0x2a) {
      pos += 2;
      while (at() !== EOF && !(at() === 0x2a && at(1) === 0x2f)) pos++;
      if (at() !== EOF) pos += 2;
    }
    const c = at();
    if (c === EOF) return null;
    if (isWhitespace(c)) {
      while (isWhitespace(at())) pos++;
      return { type: "whitespace", value: " " };
    }
    if (c === 0x22 || c === 0x27) {
      pos++;
      return consumeString(c);
    }
    if (c === 0x23) {
      pos++;
      if (isName(at()) || validEscape()) {
        return { type: "hash", value: consumeName() };
      }
      return { type: "delim", value: "#" };
    }
    if (c === 0x2b || c === 0x2e) {
      if (startsNumber()) return consumeNumeric();
    } else if (c === 0x2d) {
      if (startsNumber()) return consumeNumeric();
      if (at(1) === 0x2d && at(2) === 0x3e) {
        pos += 3;
        return { type: "cdc", value: "-->" };
      }
      if (startsIdent()) return consumeIdentLike();
    } else if (c === 0x3c) {
      if (at(1) === 0x21 && at(2) === 0x2d && at(3) === 0x2d) {
        pos += 4;
        return { type: "cdo", value: "<!--" };
      }
    } else if (c === 0x40) {
      if (startsIdent(1)) {
        pos++;
        return { type: "at-keyword", value: consumeName() };
      }
    } else if (c === 0x5c) {
      if (validEscape()) return consumeIdentLike();
    } else if (isDigit(c)) {
      return consumeNumeric();
    } else if (
      engine.unicodeRange &&
      (c === 0x55 || c === 0x75) &&
      at(1) === 0x2b &&
      (isHex(at(2)) || at(2) === 0x3f)
    ) {
      return consumeUnicodeRange();
    } else if (isNameStart(c)) {
      return consumeIdentLike();
    }
    pos++;
    return { type: "delim", value: String.fromCodePoint(c) };
  };

  for (;;) {
    const token = consumeToken();
    if (!token) return tokens;
    tokens.push(token);
  }
}

const isDataAddress = (address: string) => /^[\0- ]*data:/i.test(address);
const STRING_ADDRESS_FUNCTION = /^(-[a-z]+-)?(image-set|image|src)$/i;

/** Everything in the stylesheet that could make some browser engine fetch from a host. */
export function remoteReferences(css: string): string[] {
  const found = new Set<string>();
  for (const engine of ENGINES) {
    const tokens = tokenize(css, engine);
    tokens.forEach((token, index) => {
      if (token.type === "url") {
        if (!isDataAddress(token.value)) found.add(`url(${token.value})`);
      } else if (token.type === "at-keyword") {
        if (token.value.toLowerCase() === "import") found.add("@import");
      } else if (token.type === "function") {
        const name = token.value.toLowerCase();
        if (STRING_ADDRESS_FUNCTION.test(name)) found.add(`${name}()`);
        if (name !== "url") return;
        const next = tokens
          .slice(index + 1)
          .find((later) => later.type !== "whitespace");
        if (next?.type !== "string" || !isDataAddress(next.value)) {
          found.add(`url("${next?.value ?? ""}")`);
        }
      }
    });
  }
  return [...found];
}
