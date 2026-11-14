// One rule for "this buffer has a mention you haven't seen", shared by the
// channel badge and the server dot. They used to disagree: the server dot only
// looked at isMentioned, the badge also needed a count, so a dot could stay
// lit with no badge anywhere to show where it came from.

import type { Server } from "../types";

interface MentionState {
  isMentioned: boolean;
  mentionCount?: number;
}

export function hasUnreadMention(buffer: MentionState): boolean {
  return buffer.isMentioned && (buffer.mentionCount ?? 0) > 0;
}

export function serverHasUnreadMention(server: Server): boolean {
  return (
    server.channels.some(hasUnreadMention) ||
    !!server.privateChats?.some(hasUnreadMention)
  );
}
