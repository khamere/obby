import useStore from "../store";
import {
  findSavedMessage,
  loadOlderMessages,
  type SavedMessage,
} from "../store/handlers/history";
import { findReplyTarget } from "../store/helpers";
import ircClient from "./ircClient";
import { jumpToMessage, reportJumpFailure } from "./jumpToMessage";

// A server has no way to look a message up by id, so a reply to one that was
// never saved is found by paging back from what is loaded; this many pages
// is as far as a click goes.
const MAX_OLDER_PAGES = 6;
const OLDER_PAGE_TIMEOUT_MS = 8000;

// The name a conversation is addressed by on the wire: the channel, or the
// other person's nick.
export function conversationName(
  serverId: string,
  channelId: string,
): string | undefined {
  const server = useStore.getState().servers.find((s) => s.id === serverId);
  if (!server) return undefined;
  return (
    server.channels.find((c) => c.id === channelId)?.name ??
    server.privateChats?.find((pc) => pc.id === channelId)?.username
  );
}

export function savedReply(
  serverId: string,
  channelId: string,
  msgid: string,
): Promise<SavedMessage | null> {
  const target = conversationName(serverId, channelId);
  if (!target) return Promise.resolve(null);
  return findSavedMessage(useStore, serverId, target, msgid);
}

function loadedReply(key: string, msgid: string) {
  return findReplyTarget(msgid, useStore.getState().messages[key] ?? []);
}

// Resolves once the conversation's oldest loaded message is no longer the
// given one, loading ends, the server refuses the page, or on timeout. A
// page read from disk may have landed before the wait starts.
function waitForOlderPage(
  key: string,
  serverId: string,
  oldestId: string | undefined,
  target: string,
): Promise<"page" | "refused"> {
  return new Promise((resolve) => {
    if (useStore.getState().messages[key]?.[0]?.id !== oldestId)
      return resolve("page");
    const onFail: Parameters<typeof ircClient.on<"FAIL">>[1] = (fail) => {
      if (fail.serverId !== serverId || fail.command !== "CHATHISTORY") return;
      if (!fail.context.some((p) => p.toLowerCase() === target.toLowerCase()))
        return;
      finish("refused");
    };
    const finish = (outcome: "page" | "refused") => {
      stop();
      ircClient.deleteHook("FAIL", onFail);
      clearTimeout(timer);
      resolve(outcome);
    };
    ircClient.on("FAIL", onFail);
    const isLoading = () => {
      const server = useStore.getState().servers.find((s) => s.id === serverId);
      return [
        ...(server?.channels ?? []),
        ...(server?.privateChats ?? []),
      ].some((c) => `${serverId}-${c.id}` === key && c.isLoadingHistory);
    };
    let sawLoading = isLoading();
    const stop = useStore.subscribe(() => {
      const loading = isLoading();
      sawLoading ||= loading;
      const oldestChanged =
        useStore.getState().messages[key]?.[0]?.id !== oldestId;
      if (!oldestChanged && (loading || !sawLoading)) return;
      finish("page");
    });
    const timer = setTimeout(() => finish("page"), OLDER_PAGE_TIMEOUT_MS);
  });
}

/**
 * Scrolls to the message a reply points at. A loaded original is shown at
 * once; a saved one is shown inside its saved surroundings; anything else is
 * paged back to from the server, within a bound.
 */
export async function jumpToReply(
  serverId: string,
  channelId: string,
  msgid: string,
): Promise<void> {
  const key = `${serverId}-${channelId}`;
  const loaded = loadedReply(key, msgid);
  if (loaded) {
    useStore.getState().revealMessage(loaded.id);
    return;
  }
  const target = conversationName(serverId, channelId);
  if (!target) return;
  const saved = await savedReply(serverId, channelId, msgid);
  if (saved) {
    const result = await jumpToMessage({
      serverId,
      target,
      time: saved.time,
      msgid,
      nick: saved.nick,
      text: saved.text,
    });
    if (result.ok) return;
    if (result.reason === "left-channel") {
      reportJumpFailure(serverId, result.reason);
      return;
    }
  }
  let direct = false;
  for (let page = 0; page < MAX_OLDER_PAGES; page++) {
    const oldest = useStore.getState().messages[key]?.[0];
    const oldestTime = oldest
      ? new Date(oldest.timestamp).getTime()
      : Date.now();
    // Saved history may be unreachable while another tab holds the database;
    // the server still has the page.
    const coming = await loadOlderMessages(
      useStore,
      serverId,
      target,
      oldestTime,
    ).catch(() => {
      direct = true;
      // No loading mark, since a refusal would leave it on with nothing to
      // clear it.
      return ircClient.requestChathistoryBefore(
        serverId,
        target,
        new Date(oldestTime).toISOString(),
        { showLoading: false },
      );
    });
    if (!coming) break;
    const outcome = await waitForOlderPage(key, serverId, oldest?.id, target);
    if (outcome === "refused" && direct) break;
    const found = loadedReply(key, msgid);
    if (found) {
      useStore.getState().revealMessage(found.id);
      return;
    }
    const stillOldest = useStore.getState().messages[key]?.[0];
    if (stillOldest?.id === oldest?.id) break;
  }
  reportJumpFailure(serverId, "not-found");
}
