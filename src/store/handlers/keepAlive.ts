import { plural, t } from "@lingui/core/macro";
import type { StoreApi } from "zustand";
import { requestBatteryExemption, setKeepAlive } from "../../lib/keepAlive";
import { isTauriAndroid } from "../../lib/platformUtils";
import type { AppState } from "../index";

const EXEMPTION_ASKED_KEY = "obby.batteryExemptionAsked";

function connectedNetworks(state: AppState): number {
  return state.servers.filter(
    (server) => server.isConnected && !server.isBouncerControl,
  ).length;
}

// The ongoing notification follows the connections: it appears with the
// first connected network, names how many there are, and goes once the last
// one is gone or the user turns the feature off.
export function registerKeepAliveHandlers(
  store: StoreApi<AppState>,
): () => void {
  if (!isTauriAndroid()) return () => {};
  // The native calls run one after another, so a start and a stop that
  // follow each other quickly reach the service in that order. A state
  // counts as applied once its call has succeeded; a refused start, which
  // Android gives a backgrounded app, is tried again when the app is back
  // on the screen.
  let applied = "";
  let requested = "";
  let queue: Promise<void> = Promise.resolve();
  const sync = (state: AppState) => {
    const count = connectedNetworks(state);
    const enabled =
      state.globalSettings.keepConnectionAlive !== false && count > 0;
    const status = plural(count, {
      one: "Connected to # network",
      other: "Connected to # networks",
    });
    const wanted = JSON.stringify([enabled, status]);
    if (wanted === requested) return;
    requested = wanted;
    queue = queue
      .then(() => setKeepAlive(enabled, status, t`Connection`))
      .then(
        () => {
          applied = wanted;
        },
        (error) => {
          console.warn("keep-alive update failed", error);
          // The state stays unapplied, so the next look asks for it again.
          if (requested === wanted) requested = applied;
        },
      );
    if (enabled && !hasAskedForExemption()) {
      rememberExemptionAsked();
      void requestBatteryExemption().catch(() => false);
    }
  };
  sync(store.getState());
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.servers !== previous.servers ||
      state.globalSettings !== previous.globalSettings
    )
      sync(state);
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") sync(store.getState());
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function hasAskedForExemption(): boolean {
  try {
    return localStorage.getItem(EXEMPTION_ASKED_KEY) === "1";
  } catch {
    return true;
  }
}

function rememberExemptionAsked(): void {
  try {
    localStorage.setItem(EXEMPTION_ASKED_KEY, "1");
  } catch {
    // storage disabled: the dialog may show again next launch
  }
}
