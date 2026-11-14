import { useEffect } from "react";
import {
  autoAwayRecord,
  autoAwaySeenAway,
  decideAutoAway,
  dropReleasedAutoAway,
  expectAutoBack,
  holdsAutoAway,
  setAutoAwayRecord,
  setAutoAwaySeenAway,
} from "../lib/autoAway";
import ircClient from "../lib/ircClient";
import useStore from "../store";

const CHECK_INTERVAL_MS = 30_000;
const INPUT_CHECK_MS = 1_000;
// A tick this late means the device slept or the app was paused, which says nothing about the user.
const RESUME_GAP_MS = 3 * CHECK_INTERVAL_MS;
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export function useAutoAway(): void {
  useEffect(() => {
    let lastActivity = Date.now();

    const check = () => {
      const state = useStore.getState();
      const { next, setAway, clearAway, seenAway } = decideAutoAway({
        minutes: Number(state.globalSettings.autoAwayMinutes) || 0,
        idleMs: Date.now() - lastActivity,
        servers: state.servers,
        ours: autoAwayRecord(),
        wasAway: autoAwaySeenAway(),
      });
      setAutoAwayRecord(next);
      setAutoAwaySeenAway(seenAway);
      const message = state.globalSettings.awayMessage || "Away";
      for (const id of setAway) ircClient.setAway(id, message);
      for (const id of clearAway) {
        expectAutoBack(id);
        ircClient.clearAway(id);
      }
    };

    // We check at most once a second on input so pointer movement stays cheap, and once more after the last input.
    let lastInputCheck = 0;
    let trailingCheck = 0;
    const onActivity = () => {
      lastActivity = Date.now();
      dropReleasedAutoAway();
      if (autoAwayRecord().size === 0) return;
      const wait = INPUT_CHECK_MS - (lastActivity - lastInputCheck);
      if (wait > 0) {
        if (!trailingCheck)
          trailingCheck = window.setTimeout(() => {
            trailingCheck = 0;
            lastInputCheck = Date.now();
            check();
          }, wait);
        return;
      }
      lastInputCheck = lastActivity;
      check();
    };

    let lastTick = Date.now();
    const onTick = () => {
      const now = Date.now();
      // An away we already set stays until real input.
      if (now - lastTick > RESUME_GAP_MS && !holdsAutoAway())
        lastActivity = now;
      lastTick = now;
      check();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") onActivity();
    };

    for (const type of ACTIVITY_EVENTS)
      window.addEventListener(type, onActivity, {
        capture: true,
        passive: true,
      });
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(onTick, CHECK_INTERVAL_MS);
    return () => {
      for (const type of ACTIVITY_EVENTS)
        window.removeEventListener(type, onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
      window.clearTimeout(trailingCheck);
    };
  }, []);
}
