import { v4 as uuidv4 } from "uuid";
import useStore from "../store";
import { showSavedHistory } from "../store/handlers/history";
import type { Message, PrivateChat, User } from "../types";
import ircClient from "./ircClient";

// We keep a private chat for a nick only, so these match the other targets a
// message takes: a channel behind a status prefix, a list, a mask, a nick@server.
const NOT_A_NICK = /[\s,*?!@.$:]/;

// We list the private chat of a nick we message from another buffer, so the
// server's echo or our own copy of the message has a place to show.
export function privateChatForOwnMessage(
  serverId: string,
  target: string,
): PrivateChat | undefined {
  if (
    !target ||
    NOT_A_NICK.test(target) ||
    ircClient.isChannel(serverId, target) ||
    ircClient.isChannel(serverId, target.slice(1))
  )
    return undefined;
  const findChat = () =>
    useStore
      .getState()
      .servers.find((s) => s.id === serverId)
      ?.privateChats?.find(
        (pc) => pc.username.toLowerCase() === target.toLowerCase(),
      );
  if (!findChat()) useStore.getState().openPrivateChat(serverId, target);
  const chat = findChat();
  // Without an echo our own copy and its saved row carry different times, so we show the saved history before the copy goes in and the two never meet.
  if (chat && !ircClient.hasCapability(serverId, "echo-message"))
    showSavedHistory(useStore, serverId, chat.username);
  return chat;
}

// With echo-message the server sends our private message back and that echo
// is the copy we show, so we only place one ourselves when nothing comes back.
export function showOwnPrivateMessage(
  serverId: string,
  chat: PrivateChat,
  user: User,
  content: string,
  replyMessage: Message | null,
) {
  if (ircClient.hasCapability(serverId, "echo-message")) return;
  useStore.getState().addMessage({
    id: uuidv4(),
    content,
    timestamp: new Date(),
    userId: user.username || user.id,
    channelId: chat.id,
    serverId,
    type: "message",
    reactions: [],
    replyMessage,
    mentioned: [],
  });
}
