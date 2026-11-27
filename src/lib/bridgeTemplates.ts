// Bridge rules describe how a shoutbox bot wraps a person's name with small
// templates such as "[{nick}] {text}" instead of regular expressions, so a
// rules file loaded from a link can never hand the browser a pattern that
// backtracks for seconds. Every piece compiles to a bounded character class,
// which keeps matching linear in the message length.

export type TemplateKind = "message" | "nick";

export interface BridgeMatch {
  nick: string;
  text: string;
}

export const MAX_TEMPLATE_CHARS = 200;
const MAX_NICK_CHARS = 32;

// A bridge may slip these into a name so that IRC clients do not highlight
// the person. We read past them and leave them out of the name, so one person
// keeps one name however the bridge wrote it.
const INVISIBLE = "\\u200B\\u200C\\u200D\\u2060\\uFEFF";
const INVISIBLE_CHARS = new RegExp(`[${INVISIBLE}]`, "gu");

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Inside a character class only a few characters need escaping.
function escapeClassChar(ch: string): string {
  return /[\]\\^-]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compiles a template to an anchored pattern, or null when the template is
 * not valid: longer than 200 characters, no or several {nick}, an unknown
 * placeholder, a message template that does not end with {text}, or a nick
 * template that contains {text}.
 */
export function compileTemplate(
  template: string,
  kind: TemplateKind,
): RegExp | null {
  if (template.length > MAX_TEMPLATE_CHARS) return null;
  const tokens = template.match(/\{[^{}]*\}|[^{]+|\{/g) ?? [];
  let pattern = "^";
  let nicks = 0;
  let texts = 0;
  let wildcards = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = Array.from(tokens[i + 1] ?? "")[0];
    const stop = next && next !== "{" ? escapeClassChar(next) : "";
    if (token === "{nick}") {
      nicks++;
      // The limit counts the characters of the name itself. The two classes
      // share no character, so there is one way to read a name and matching
      // stays linear.
      pattern += `((?:[${INVISIBLE}]*[^\\s${INVISIBLE}${stop}]){1,${MAX_NICK_CHARS}}[${INVISIBLE}]*)`;
    } else if (token === "{text}") {
      texts++;
      if (kind !== "message" || i !== tokens.length - 1) return null;
      pattern += "([\\s\\S]*)";
    } else if (token === "{_}") {
      // A wildcard needs a literal to stop at, and only one is allowed, so
      // two open-ended pieces never sit next to each other.
      wildcards++;
      if (!stop || wildcards > 1) return null;
      pattern += `[^${stop}]*`;
    } else if (token.length > 1 && token.startsWith("{")) {
      return null;
    } else {
      pattern += escapeRegex(token.replace(/ +/g, " ")).replace(/ /g, "\\s+");
    }
  }
  if (nicks !== 1) return null;
  if (kind === "message" && texts !== 1) return null;
  if (kind === "nick") pattern += "$";
  return new RegExp(pattern, "u");
}

export function matchTemplate(re: RegExp, input: string): BridgeMatch | null {
  const found = re.exec(input);
  if (!found) return null;
  return {
    nick: found[1].replace(INVISIBLE_CHARS, ""),
    text: found[2] ?? "",
  };
}
