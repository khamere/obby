import useStore from "../store";
import type { MentionEntry } from "../store/mentionLog";
import { mentionChannelKey } from "../store/mentionLog";
import { plainText } from "./history/searchFields";
import ircClient from "./ircClient";
import { jumpToMessage, reportJumpFailure } from "./jumpToMessage";

// How long a page asked from the server around the mention may take.
const SERVER_PAGE_TIMEOUT_MS = 8000;

function findInChannel(entry: MentionEntry) {
  const messages = useStore.getState().messages[mentionChannelKey(entry)] ?? [];
  const time = Date.parse(entry.timestamp);
  const text = plainText(entry.content);
  return messages.find(
    (m) =>
      m.id === entry.messageId ||
      (!!entry.msgid &&
        (m.msgid === entry.msgid ||
          !!m.multilineMessageIds?.includes(entry.msgid))) ||
      (new Date(m.timestamp).getTime() === time &&
        m.userId.toLowerCase() === entry.sender.toLowerCase() &&
        plainText(m.content) === text),
  );
}

// Resolves once the mention's message is in the channel buffer, or on timeout.
function waitForMessage(entry: MentionEntry): Promise<boolean> {
  return new Promise((resolve) => {
    if (findInChannel(entry)) return resolve(true);
    const stop = useStore.subscribe(() => {
      if (!findInChannel(entry)) return;
      stop();
      clearTimeout(timer);
      resolve(true);
    });
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, SERVER_PAGE_TIMEOUT_MS);
  });
}

/**
 * Scrolls the mention's channel to its message. The message is still loaded
 * most of the time; otherwise the saved history is tried, and as a last
 * resort the server is asked for the page around it, which is what a bouncer
 * without msgids leaves us (nothing of its history is saved locally).
 */
export async function jumpToMention(entry: MentionEntry): Promise<void> {
  const { serverId, channelName } = entry;
  const loaded = findInChannel(entry);
  if (loaded) {
    useStore.getState().revealMessage(loaded.id);
    return;
  }
  const time = Date.parse(entry.timestamp);
  const result = await jumpToMessage({
    serverId,
    target: channelName,
    time,
    msgid: entry.msgid,
    nick: entry.sender,
    text: plainText(entry.content),
  });
  if (result.ok) return;
  if (result.reason === "left-channel") {
    reportJumpFailure(serverId, result.reason);
    return;
  }
  const asked = ircClient.requestChathistoryAt(
    serverId,
    channelName,
    "AROUND",
    new Date(time).toISOString(),
  );
  if (asked && (await waitForMessage(entry))) {
    const found = findInChannel(entry);
    if (found) {
      useStore.getState().revealMessage(found.id);
      return;
    }
  }
  reportJumpFailure(serverId, result.reason);
}
