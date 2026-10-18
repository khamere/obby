import type { StoreApi } from "zustand";
import { syncTitleAlert } from "../../lib/titleAlert";
import { getCurrentSelection } from "../helpers";
import type { AppState } from "../index";

function visibleConversation(state: AppState): [string | null, string | null] {
  const selection = getCurrentSelection(state);
  return [
    state.ui.selectedServerId,
    selection.selectedPrivateChatId ?? selection.selectedChannelId,
  ];
}

export function registerTitleAlertHandlers(store: StoreApi<AppState>): void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof window.addEventListener !== "function" ||
    typeof document.addEventListener !== "function"
  ) {
    return;
  }

  const sync = () => {
    const [serverId, conversationId] = visibleConversation(store.getState());
    syncTitleAlert(serverId, conversationId);
  };

  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);

  store.subscribe((state, prev) => {
    if (state.ui === prev.ui) return;
    const [serverId, conversationId] = visibleConversation(state);
    const [prevServerId, prevConversationId] = visibleConversation(prev);
    if (serverId === prevServerId && conversationId === prevConversationId) {
      return;
    }
    syncTitleAlert(serverId, conversationId);
  });
}
