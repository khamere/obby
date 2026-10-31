import { v4 as uuidv4 } from "uuid";
import useStore from "../store";
import type { User } from "../types";
import ircClient from "./ircClient";

// Channels always reflect our own lines back, and so do DMs on servers with
// echo-message. Only a DM on a server without it needs a local copy; adding
// one anyway shows the line twice, because the echo carries the server's
// timestamp and so never matches the copy as a duplicate.
export function addLocalDmCopy(
  serverId: string,
  privateChatId: string,
  user: Pick<User, "id" | "username">,
  content: string,
): void {
  if (ircClient.hasCapability(serverId, "echo-message")) return;
  useStore.getState().addMessage({
    id: uuidv4(),
    content,
    timestamp: new Date(),
    userId: user.username || user.id,
    channelId: privateChatId,
    serverId,
    type: "message",
    reactions: [],
    replyMessage: null,
    mentioned: [],
  });
}
