// Recent channel mentions of the user, newest last. The jump bar walks the
// unseen ones in the open channel. DMs are left out: every line of a DM is
// addressed to you, and the conversation itself is the list.

export interface MentionEntry {
  // Internal id of the message, for jumping while it is still loaded.
  messageId: string;
  // IRC msgid, for finding the message again once it has been paged out.
  msgid?: string;
  serverId: string;
  channelId: string;
  channelName: string;
  sender: string;
  content: string;
  timestamp: string;
  seen: boolean;
}

export const MAX_MENTIONS = 200;

export const mentionChannelKey = (m: MentionEntry) =>
  `${m.serverId}-${m.channelId}`;

export const mentionTarget = (m: MentionEntry) => m.msgid ?? m.messageId;

export function addMention(
  log: MentionEntry[],
  entry: MentionEntry,
): MentionEntry[] {
  if (entry.msgid && log.some((m) => m.msgid === entry.msgid)) return log;
  return [...log, entry].slice(-MAX_MENTIONS);
}

export function markMentionsSeen(
  log: MentionEntry[],
  match: (m: MentionEntry) => boolean,
): MentionEntry[] {
  if (!log.some((m) => !m.seen && match(m))) return log;
  return log.map((m) => (!m.seen && match(m) ? { ...m, seen: true } : m));
}

export function unseenMentions(
  log: MentionEntry[],
  channelKey: string,
): MentionEntry[] {
  return log.filter((m) => !m.seen && mentionChannelKey(m) === channelKey);
}
