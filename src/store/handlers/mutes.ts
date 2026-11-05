import type { StoreApi } from "zustand";
import { isSilenced, subscribeMutes } from "../../lib/mutes";
import type { AppState } from "../index";
import { markMentionsSeen } from "../mentionLog";

// A mute covers the mentions already logged for the chat, or the badge and
// the jump bar would keep pointing at a conversation the user just silenced.
// The restored log gets the same treatment, since a mute may have been set
// in another session.
export function registerMuteHandlers(store: StoreApi<AppState>): void {
  const settle = () =>
    store.setState((state) => ({
      mentionLog: markMentionsSeen(state.mentionLog, (m) =>
        isSilenced(m.serverId, m.channelId, true),
      ),
    }));
  settle();
  subscribeMutes(settle);
}
