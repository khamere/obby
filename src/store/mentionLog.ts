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

const REQUIRED_TEXT_FIELDS = [
  "messageId",
  "serverId",
  "channelId",
  "channelName",
  "sender",
  "content",
  "timestamp",
] as const;

// The saved log is read back as plain JSON, and the views call string methods
// on these fields, do date arithmetic on the timestamp and count the entries
// that are not seen, so we only accept an entry they can all work with. An
// entry also has to name its server and channel, or no view can place it.
export function isMentionEntry(value: unknown): value is MentionEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    REQUIRED_TEXT_FIELDS.every((field) => typeof entry[field] === "string") &&
    entry.serverId !== "" &&
    entry.channelId !== "" &&
    entry.channelName !== "" &&
    !Number.isNaN(Date.parse(entry.timestamp as string)) &&
    typeof entry.seen === "boolean" &&
    (entry.msgid === undefined || typeof entry.msgid === "string")
  );
}

export const mentionChannelKey = (
  m: Pick<MentionEntry, "serverId" | "channelId">,
) => `${m.serverId}-${m.channelId}`;

export const mentionTarget = (m: MentionEntry) => m.msgid ?? m.messageId;

const isSameLine = (a: MentionEntry, b: MentionEntry) =>
  a.serverId === b.serverId &&
  a.channelId === b.channelId &&
  a.timestamp === b.timestamp &&
  a.sender.toLowerCase() === b.sender.toLowerCase() &&
  a.content === b.content;

export function addMention(
  log: MentionEntry[],
  entry: MentionEntry,
): MentionEntry[] {
  // Every connection we hold to a network logs the line under the same msgid, so the server tells them apart.
  const isSameMsgid = (m: MentionEntry) =>
    m.msgid === entry.msgid && m.serverId === entry.serverId;
  if (entry.msgid && log.some(isSameMsgid)) return log;
  // A server without msgids sends the same line again on every replay, and
  // only its channel, sender, time and text tell us we have it.
  if (!entry.msgid && log.some((m) => isSameLine(m, entry))) return log;
  // A mention found in older history lands among the ones we already hold,
  // so the log stays in the order the lines were said.
  let at = log.length;
  while (at > 0 && log[at - 1].timestamp > entry.timestamp) at--;
  return [...log.slice(0, at), entry, ...log.slice(at)].slice(-MAX_MENTIONS);
}

// A channel's id follows the name it had when we joined, so the mentions logged under its name move to the row it has now.
export function withChannelId(
  log: MentionEntry[],
  serverId: string,
  channelName: string,
  channelId: string,
): MentionEntry[] {
  const isElsewhere = (m: MentionEntry) =>
    m.serverId === serverId &&
    m.channelId !== channelId &&
    m.channelName.toLowerCase() === channelName.toLowerCase();
  return log.some(isElsewhere)
    ? log.map((m) => (isElsewhere(m) ? { ...m, channelId } : m))
    : log;
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
