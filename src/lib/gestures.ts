// A touch that starts on something that handles its own dragging belongs to
// that thing: an element marked data-no-gesture (a map, a carousel, a sheet),
// or any block that scrolls sideways, such as server text wider than a phone
// screen. The page swipe leaves those alone.
export function isGestureClaimed(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element) return false;
  if (element.closest?.("[data-no-gesture]")) return true;
  let node: Element | null = element.nodeType === 1 ? element : null;
  while (node && node !== document.body) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    node = node.parentElement;
  }
  return false;
}
