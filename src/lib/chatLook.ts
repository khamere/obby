// Chat looks that are neither theme colours nor typography: which nick
// colour palette to use, and an optional background image behind the
// messages. Applied as an attribute and CSS variables on <html>; index.css
// defines the palettes and draws the background.

export type NickPalette = "pastel" | "vivid" | "mono";

export interface ChatLookSettings {
  nickPalette: NickPalette;
  // A base64 data URI of a PNG/JPEG/WebP/GIF, or "" for none. Only data
  // URIs are accepted so the page never fetches anything for it.
  chatBackground: string;
  chatBackgroundOpacity: number; // 0-100
}

export const DEFAULT_CHAT_LOOK: ChatLookSettings = {
  nickPalette: "pastel",
  chatBackground: "",
  chatBackgroundOpacity: 30,
};

// ~2 MB of base64
export const MAX_BACKGROUND_CHARS = 2_800_000;

const BACKGROUND =
  /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

export function isValidBackgroundImage(value: string): boolean {
  return value.length < MAX_BACKGROUND_CHARS && BACKGROUND.test(value);
}

interface RootLike {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyChatLook(
  settings: Partial<ChatLookSettings>,
  root: RootLike = document.documentElement,
): void {
  const s = { ...DEFAULT_CHAT_LOOK, ...settings };
  const palette: NickPalette = ["pastel", "vivid", "mono"].includes(
    s.nickPalette,
  )
    ? s.nickPalette
    : "pastel";
  root.setAttribute("data-nick-palette", palette);
  root.style.setProperty(
    "--obby-chat-bg",
    isValidBackgroundImage(s.chatBackground)
      ? `url("${s.chatBackground}")`
      : "none",
  );
  const opacity = Number.isFinite(s.chatBackgroundOpacity)
    ? Math.min(100, Math.max(0, s.chatBackgroundOpacity))
    : DEFAULT_CHAT_LOOK.chatBackgroundOpacity;
  root.style.setProperty("--obby-chat-bg-opacity", String(opacity / 100));
}
