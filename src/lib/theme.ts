// Themes: a named set of colours for the tokens index.css defines on :root
// (see the --obby-* variables). Applying a theme writes those variables on
// <html>; Tailwind's discord.* colours read them, so every component follows
// without knowing about themes. Custom CSS loads later and still wins.

import bubblegum from "../themes/bubblegum.json";
import catppuccinMocha from "../themes/catppuccin-mocha.json";
import dracula from "../themes/dracula.json";
import gruvboxDark from "../themes/gruvbox-dark.json";
import matrix from "../themes/matrix.json";
import nord from "../themes/nord.json";
import obbyDark from "../themes/obby-dark.json";
import oledBlack from "../themes/oled-black.json";
import tokyoNight from "../themes/tokyo-night.json";

export const THEME_TOKENS = [
  "primary",
  "green",
  "yellow",
  "fuchsia",
  "red",
  "bg-input",
  "bg-base",
  "bg-sidebar",
  "bg-deep",
  "icon",
  "bg-member",
  "bg-hover",
  "fg",
  "fg-muted",
  "link",
  "fg-channel",
  "fg-channel-active",
  "success",
  "success-hover",
  "button-secondary",
  "reply",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeAppearance = "dark" | "light";

export interface ThemeDefinition {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: Record<ThemeToken, string>;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const DEFAULT_THEME_ID = "obby-dark";

export interface ThemeSettings {
  // A preset id, "custom" (the edited theme in customTheme) or "link"
  // (the theme loaded from the shared link, see lib/themeLink).
  theme: string;
  accentColor: string;
  // JSON of a ThemeDefinition, or "" when the user has not made one.
  customTheme: string;
}

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  theme: DEFAULT_THEME_ID,
  accentColor: "",
  customTheme: "",
};

export const CUSTOM_THEME_ID = "custom";
export const LINK_THEME_ID = "link";

export function parseThemeJson(text: string): ThemeDefinition | null {
  try {
    return validateTheme(JSON.parse(text));
  } catch {
    return null;
  }
}

export function serializeTheme(theme: ThemeDefinition): string {
  return JSON.stringify(theme, null, 2);
}

/**
 * The accent to apply: the selected network's own colour if it has one,
 * else the global accent setting, else "" (the theme's primary).
 */
export function effectiveAccent(
  serverAccent: string | undefined,
  globalAccent: string,
): string {
  if (isHexColor(serverAccent)) return serverAccent;
  if (isHexColor(globalAccent)) return globalAccent;
  return "";
}

/** The theme the settings point at, falling back to the default. */
export function resolveTheme(
  settings: Pick<ThemeSettings, "theme" | "customTheme">,
  linked: ThemeDefinition | null,
): ThemeDefinition {
  if (settings.theme === CUSTOM_THEME_ID) {
    return parseThemeJson(settings.customTheme) ?? getTheme(DEFAULT_THEME_ID);
  }
  if (settings.theme === LINK_THEME_ID) {
    return linked ?? getTheme(DEFAULT_THEME_ID);
  }
  return getTheme(settings.theme);
}

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  obbyDark,
  oledBlack,
  catppuccinMocha,
  dracula,
  nord,
  gruvboxDark,
  tokyoNight,
  bubblegum,
  matrix,
].map((t) => validateTheme(t) as ThemeDefinition);

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

// "h s% l%" for the few shadcn-style classes (bg-primary, ring-primary) that
// read hsl(var(--primary)).
export function hexToHsl(hex: string): string {
  const [r, g, b] = hexToTriplet(hex)
    .split(" ")
    .map((v) => Number(v) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function hexToTriplet(hex: string): string {
  let h = hex.slice(1);
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = Number.parseInt(h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

// Accepts only what a theme may contain: an id, a name, an appearance and
// one hex colour per token. Unknown keys are dropped, so a theme can never
// smuggle in a URL or any other CSS.
export function validateTheme(input: unknown): ThemeDefinition | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID.test(o.id)) return null;
  if (typeof o.name !== "string" || !o.name.trim()) return null;
  if (o.appearance !== "dark" && o.appearance !== "light") return null;
  if (!o.colors || typeof o.colors !== "object") return null;
  const src = o.colors as Record<string, unknown>;
  const colors = {} as Record<ThemeToken, string>;
  for (const token of THEME_TOKENS) {
    const v = src[token];
    if (!isHexColor(v)) return null;
    colors[token] = v.toLowerCase();
  }
  return {
    id: o.id,
    name: o.name.trim().slice(0, 60),
    appearance: o.appearance,
    colors,
  };
}

export function getTheme(id: string): ThemeDefinition {
  return (
    BUILT_IN_THEMES.find((t) => t.id === id) ??
    (BUILT_IN_THEMES.find((t) => t.id === DEFAULT_THEME_ID) as ThemeDefinition)
  );
}

interface RootLike {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyTheme(
  theme: ThemeDefinition,
  accentOverride = "",
  root: RootLike = document.documentElement,
): void {
  for (const token of THEME_TOKENS) {
    root.style.setProperty(
      `--obby-${token}`,
      hexToTriplet(theme.colors[token]),
    );
  }
  const accent = isHexColor(accentOverride)
    ? accentOverride
    : theme.colors.primary;
  root.style.setProperty("--obby-primary", hexToTriplet(accent));
  root.style.setProperty("--primary", hexToHsl(accent));
  root.style.setProperty("--ring", hexToHsl(accent));
  root.setAttribute("data-obby-theme", theme.id);
  root.setAttribute("data-appearance", theme.appearance);
}
