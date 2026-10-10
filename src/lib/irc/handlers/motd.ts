import type { IRCClientContext } from "../IRCClientContext";

// MOTD lines arrive as one RPL_MOTD each between RPL_MOTDSTART and
// RPL_ENDOFMOTD, and are emitted as a single MOTD event at the end.
const pending = new Map<string, string[]>();

// Connections where the user asked for the MOTD with /motd. ERR_NOMOTD is
// only worth showing as an answer to that: bouncers like soju send it on
// every connect ("Use /motd to read the message of the day"), and posting it
// each time would add a line per network on every reconnect.
const requested = new Set<string>();

export function noteMotdRequested(serverId: string): void {
  requested.add(serverId);
}

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
  requested.delete(serverId);
  ctx.triggerEvent("MOTD", { serverId, source, lines });
}

// ERR_NOMOTD, shown only in reply to /motd (e.g. "MOTD File is missing").
export function handleNoMotd(
  ctx: IRCClientContext,
  serverId: string,
  source: string,
  trailing: string,
): void {
  pending.delete(serverId);
  if (!requested.delete(serverId)) return;
  ctx.triggerEvent("MOTD", {
    serverId,
    source,
    lines: [],
    missing: trailing || "No MOTD",
  });
}
