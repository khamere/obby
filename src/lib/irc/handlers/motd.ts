import type { IRCClientContext } from "../IRCClientContext";

// MOTD lines arrive as one RPL_MOTD each between RPL_MOTDSTART and
// RPL_ENDOFMOTD, and are emitted as a single MOTD event at the end.
const pending = new Map<string, string[]>();

// RPL_MOTD's text is conventionally prefixed with "- ". Lines are trimmed
// before parsing, so a blank MOTD line (":- ") arrives as a lone "-".
function motdText(trailing: string): string {
  if (trailing === "-") return "";
  return trailing.startsWith("- ") ? trailing.slice(2) : trailing;
}

export function handleMotdStart(serverId: string): void {
  pending.set(serverId, []);
}

export function handleMotd(serverId: string, trailing: string): void {
  let lines = pending.get(serverId);
  if (!lines) {
    // Some servers skip RPL_MOTDSTART; collect anyway.
    lines = [];
    pending.set(serverId, lines);
  }
  lines.push(motdText(trailing));
}

export function handleEndOfMotd(
  ctx: IRCClientContext,
  serverId: string,
  source: string,
): void {
  const lines = pending.get(serverId) ?? [];
  pending.delete(serverId);
  ctx.triggerEvent("MOTD", { serverId, source, lines });
}

// ERR_NOMOTD. Bouncers use its text to explain where the MOTD went, e.g.
// soju's "Use /motd to read the message of the day".
export function handleNoMotd(
  ctx: IRCClientContext,
  serverId: string,
  source: string,
  trailing: string,
): void {
  pending.delete(serverId);
  ctx.triggerEvent("MOTD", {
    serverId,
    source,
    lines: [],
    missing: trailing || "No MOTD",
  });
}
