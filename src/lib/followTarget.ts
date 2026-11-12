// While the user is away we stop following new messages once the "New
// messages" line reaches the top, so nothing unseen scrolls out of view. A
// reader who scrolled the line up to or past that point has read past it, so
// we follow them to the end instead of pulling them back up to it.
export function followTarget(
  lineTarget: number,
  maxScrollTop: number,
  hasReadPastLine: boolean,
): number {
  if (hasReadPastLine) return maxScrollTop;
  return Math.min(maxScrollTop, Math.max(0, lineTarget));
}

// We decide this from the reader's own scrolling, since rows trimmed from the
// top as messages arrive also move the line up without anyone reading on.
export function isPastUnreadLine(
  lineViewTop: number | null,
  margin: number,
): boolean {
  return lineViewTop !== null && lineViewTop < margin - 1;
}
