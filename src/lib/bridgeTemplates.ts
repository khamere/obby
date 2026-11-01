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
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1]?.[0];
    const stop = next && next !== "{" ? escapeClassChar(next) : "";
    if (token === "{nick}") {
      nicks++;
      pattern += `([^\\s${stop}]{1,${MAX_NICK_CHARS}})`;
    } else if (token === "{text}") {
      texts++;
      if (kind !== "message" || i !== tokens.length - 1) return null;
      pattern += "([\\s\\S]*)";
    } else if (token === "{_}") {
      pattern += stop ? `[^${stop}]*` : "[\\s\\S]*";
    } else if (token.length > 1 && token.startsWith("{")) {
      return null;
    } else {
      pattern += escapeRegex(token).replace(/ /g, "\\s+");
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
  return { nick: found[1], text: found[2] ?? "" };
}
