import type { UnreadLevel } from "./desktopTray";

/** The window title carries the count and the app name only, since the
 *  taskbar, screen sharing and the browser history all show it. */
export function unreadTitle(level: UnreadLevel, mentions: number): string {
  if (level === "mention") return `(${mentions}) Obby`;
  return level === "unread" ? "• Obby" : "Obby";
}

/** Wraps the icon in an SVG with a dot in the top right corner. The white
 *  ring keeps the dot readable on any tab strip colour. */
export function markedFavicon(
  icon: string,
  color: [number, number, number],
): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image href="${icon}" width="64" height="64"/><circle cx="48" cy="16" r="16" fill="#fff"/><circle cx="48" cy="16" r="12" fill="rgb(${color.join(",")})"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
