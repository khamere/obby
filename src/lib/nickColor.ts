import useStore from "../store";

// Each nickname gets one of a fixed set of colours, derived from the nick
// itself so it's the same for everyone and on every device. The palette
// lives in index.css (--obby-nick-N) with separate dark/light variants.
export const NICK_COLOR_COUNT = 16;

// FNV-1a over the case-folded nick: cheap, stable and well spread.
export function nickColorIndex(nick: string): number {
  let hash = 0x811c9dc5;
  for (const ch of nick.toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % NICK_COLOR_COUNT;
}

export function nickColor(nick: string): string {
  return `var(--obby-nick-${nickColorIndex(nick)})`;
}

/**
 * The colour to draw a nickname in: the user's own metadata colour if they
 * set one, else their nick colour when "Colored nicknames" is on, else
 * undefined (the surrounding style applies).
 */
export function useNickColor(
  nick: string | undefined,
  metadataColor?: string,
): string | undefined {
  const enabled = useStore((s) => s.globalSettings.coloredNicknames);
  if (metadataColor) return metadataColor;
  return enabled && nick ? nickColor(nick) : undefined;
}
