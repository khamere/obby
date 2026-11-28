import type { StoreApi } from "zustand";
import { type DraftGate, flushDrafts, startDrafts } from "../../lib/drafts";
import { obbyPeerTrust } from "../../lib/e2ee/obbyIdentity";
import { e2eeSessionKey, isEncryptionEngaged } from "../../lib/e2ee/session";
import {
  isCredentialLine,
  isServicesNick,
} from "../../lib/history/historyLines";
import ircClient from "../../lib/ircClient";
import type { AppState } from "../index";

// A draft may sit on disk where the conversation's saved history may: never
// with history turned off, and in a private chat never for services, a
// password line or a conversation that is encrypted or will be again.
export const mayStoreDraft =
  (store: StoreApi<AppState>): DraftGate =>
  (serverId, name, text) => {
    const state = store.getState();
    if (state.globalSettings.keepHistory === false) return false;
    if (ircClient.isChannel(serverId, name)) return true;
    return (
      !isServicesNick(name) &&
      !text.split("\n").some(isCredentialLine) &&
      !isEncryptionEngaged(
        state.e2eeSessions[e2eeSessionKey(serverId, name)],
      ) &&
      !obbyPeerTrust.shouldAutoResume(serverId, name)
    );
  };

export function registerDraftHandlers(store: StoreApi<AppState>): void {
  startDrafts(mayStoreDraft(store));
  // A stored draft leaves the disk as soon as its chat is encrypted or history is turned off.
  store.subscribe((state, previous) => {
    if (
      state.e2eeSessions !== previous.e2eeSessions ||
      state.globalSettings.keepHistory !== previous.globalSettings.keepHistory
    )
      flushDrafts();
  });
  if (typeof window === "undefined") return;
  // The page may be closed or evicted without another chance to write.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDrafts();
  });
  window.addEventListener("pagehide", flushDrafts);
}
