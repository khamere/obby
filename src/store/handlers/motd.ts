import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import ircClient from "../../lib/ircClient";
import type { Message } from "../../types";
import type { AppState } from "../index";

export function registerMotdHandlers(store: StoreApi<AppState>): void {
  ircClient.on("MOTD", ({ serverId, source, lines, missing }) => {
    if (!store.getState().servers.some((s) => s.id === serverId)) return;
    const message: Message = {
      id: uuidv4(),
      type: "notice",
      content: missing ?? lines.join("\n"),
      timestamp: new Date(),
      userId: source,
      channelId: "server-notices",
      serverId,
      reactions: [],
      replyMessage: null,
      mentioned: [],
      motdLines: missing === undefined ? lines : undefined,
    };
    store.getState().addMessage(message);
  });
}
