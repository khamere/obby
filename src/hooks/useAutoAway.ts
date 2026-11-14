import { useEffect } from "react";
import {
  autoAwayRecord,
  decideAutoAway,
  setAutoAwayRecord,
} from "../lib/autoAway";
import ircClient from "../lib/ircClient";
import useStore from "../store";

const CHECK_INTERVAL_MS = 30_000;
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
      const { next, setAway, clearAway } = decideAutoAway({
        minutes: Number(state.globalSettings.autoAwayMinutes) || 0,
        idleMs: Date.now() - lastActivity,
        servers: state.servers,
        ours: autoAwayRecord(),
      });
      setAutoAwayRecord(next);
      const message = state.globalSettings.awayMessage || "Away";
      for (const id of setAway) ircClient.setAway(id, message);
      for (const id of clearAway) ircClient.clearAway(id);
    };

    const onActivity = () => {
      const wasIdle = Date.now() - lastActivity > CHECK_INTERVAL_MS;
      lastActivity = Date.now();
      if (wasIdle && autoAwayRecord().size > 0) check();
    };

    for (const type of ACTIVITY_EVENTS)
      window.addEventListener(type, onActivity, {
        capture: true,
        passive: true,
      });
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      for (const type of ACTIVITY_EVENTS)
        window.removeEventListener(type, onActivity, { capture: true });
      window.clearInterval(timer);
    };
  }, []);
}
