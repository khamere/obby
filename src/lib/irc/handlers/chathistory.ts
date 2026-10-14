// draft/chathistory: `CHATHISTORY TARGETS` replies look like
//   :server CHATHISTORY TARGETS <target> <timestamp>
// one line per conversation, optionally wrapped in a
// draft/chathistory-targets batch. We project each line to a typed
// CHATHISTORY_TARGET event so the store can reopen direct-message
// buffers the client forgot (a page reload drops every unpinned PM).

import type { IRCClientContext } from "../IRCClientContext";

export function handleChathistory(
  ctx: IRCClientContext,
  serverId: string,
  _source: string,
  parv: string[],
  _mtags: Record<string, string> | undefined,
): void {
  if (parv[0] !== "TARGETS") return;
  const target = parv[1];
  const timestamp = parv[2];
  if (!target || !timestamp) return;
  ctx.triggerEvent("CHATHISTORY_TARGET", { serverId, target, timestamp });
}
