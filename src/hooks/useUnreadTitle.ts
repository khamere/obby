import { useEffect } from "react";
import icon from "../../src-tauri/icons/64x64.png?inline";
import {
  DOT_COLORS,
  type UnreadLevel,
  unreadLevel,
  unreadTotals,
} from "../lib/desktopTray";
import { isTauri } from "../lib/platformUtils";
import { markedFavicon, unreadTitle } from "../lib/unreadTitle";
import useStore, { type AppState } from "../store";

/** Shows unread messages in the tab title, on the favicon and as the installed
 *  app's badge. The native apps have the tray and their own badge for this. */
export function useUnreadTitle(): void {
  useEffect(() => {
    if (isTauri()) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const original = {
      href: link?.getAttribute("href") ?? null,
      type: link?.getAttribute("type") ?? null,
    };
    const marked = {
      unread: markedFavicon(icon, DOT_COLORS.unread),
      mention: markedFavicon(icon, DOT_COLORS.mention),
    };
    let shownKey = "";
    let shownLevel: UnreadLevel = "none";
    let pageGone = false;

    const setOrRemove = (name: string, value: string | null) => {
      if (value === null) link?.removeAttribute(name);
      else link?.setAttribute(name, value);
    };
    // We paint inside the store subscriber, since a background tab throttles timers.
    const paint = (level: UnreadLevel, mentions: number) => {
      document.title = unreadTitle(level, mentions);
      if (link && level !== shownLevel) {
        setOrRemove("href", level === "none" ? original.href : marked[level]);
        setOrRemove("type", level === "none" ? original.type : "image/svg+xml");
      }
      shownLevel = level;
      if ("setAppBadge" in navigator)
        void (
          mentions > 0
            ? navigator.setAppBadge(mentions)
            : navigator.clearAppBadge()
        ).catch(() => {});
    };
    const update = (state: AppState) => {
      if (pageGone) return;
      const { unread, mentions } = unreadTotals(state.servers);
      const level = unreadLevel(unread, mentions);
      const key = `${level}:${mentions}`;
      if (key === shownKey) return;
      shownKey = key;
      paint(level, mentions);
    };
    // The badge outlives the page, so we take it down when the page goes away.
    const clear = () => {
      shownKey = "";
      paint("none", 0);
    };
    // The store still changes while the page unloads, so we stay cleared until it shows again.
    const leave = () => {
      pageGone = true;
      clear();
    };
    // A page restored from the back/forward cache gets its counts back here.
    const repaint = () => {
      pageGone = false;
      update(useStore.getState());
    };

    update(useStore.getState());
    const unsubscribe = useStore.subscribe(update);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", repaint);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", repaint);
      clear();
    };
  }, []);
}
