import { parseMessageTags } from "../ircUtils";

export interface UnsentLine {
  target: string;
  // The channel a whisper belongs to, where we report it when its nick has no chat open.
  context?: string;
  label?: string;
}

const PRIVMSG_LINE = /^(?:(@\S+) )?PRIVMSG (\S+) /i;

export function readUnsent(lines: readonly string[]): UnsentLine[] {
  const unsent: UnsentLine[] = [];
  for (const line of lines) {
    const privmsg = PRIVMSG_LINE.exec(line);
    if (!privmsg) continue;
    const tags = privmsg[1] ? parseMessageTags(privmsg[1]) : {};
    unsent.push({
      target: privmsg[2],
      context: tags["+channel-context"] || tags["+draft/channel-context"],
      label: tags.label,
    });
  }
  return unsent;
}
