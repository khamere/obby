import type { StoreApi } from "zustand";
import {
  adoptIdKeyedMutes,
  isSilenced,
  setMuteChatSource,
  subscribeMutes,
} from "../../lib/mutes";
import type { AppState } from "../index";
import { markMentionsSeen } from "../mentionLog";

// A mute covers the mentions already logged for the chat, or the badge and
// the jump bar would keep pointing at a conversation the user just silenced.
// The restored log gets the same treatment, since a mute may have been set
// in another session.
export function registerMuteHandlers(store: StoreApi<AppState>): void {
  setMuteChatSource(() => store.getState().servers);
  // A logged mention carries its channel's name, so its mute is found while
  // the channel is not loaded.
  const settle = () =>
    store.setState((state) => ({
      mentionLog: markMentionsSeen(state.mentionLog, (m) =>
        isSilenced(
          m.serverId,
          { id: m.channelId, kind: "channel", name: m.channelName },
          true,
        ),
      ),
    }));
  settle();
  subscribeMutes(settle);
  adoptIdKeyedMutes();
  store.subscribe((state, previous) => {
    if (state.servers !== previous.servers) adoptIdKeyedMutes();
  });
}
