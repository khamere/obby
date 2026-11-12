import { SCROLL_TOLERANCE } from "../hooks/useScrollToBottom";

// While the user is away we stop following new messages once the "New
// messages" line reaches the top, so nothing unseen scrolls out of view. A
// reader already below that point has read past the line, so we follow them
// to the end instead of pulling them back up to it.
export function followTarget(
  scrollTop: number,
  lineTarget: number,
  maxScrollTop: number,
): number {
  const target = Math.min(maxScrollTop, Math.max(0, lineTarget));
  return scrollTop > target + SCROLL_TOLERANCE ? maxScrollTop : target;
}
