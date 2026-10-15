// Typography settings: which font the UI and the chat use, how big, how
// spaced, and how dense message rows are. Everything is applied as CSS
// variables (and one data attribute) on <html>, so index.css stays the
// single place that decides how they are used, and custom CSS loaded
// later can still override any of them.

export type FontPreset =
  | "roboto-mono"
  | "system-mono"
  | "system-sans"
  | "system-serif"
  | "custom";
export type LineSpacing = "compact" | "normal" | "relaxed";
export type MessageDensity = "cosy" | "compact";

export interface TypographySettings {
  fontFamily: FontPreset;
  fontFamilyCustom: string;
  chatFontFamily: FontPreset;
  chatFontFamilyCustom: string;
  fontSize: number;
  lineSpacing: LineSpacing;
  messageDensity: MessageDensity;
}

export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  fontFamily: "roboto-mono",
  fontFamilyCustom: "",
  chatFontFamily: "roboto-mono",
  chatFontFamilyCustom: "",
  fontSize: 14,
  lineSpacing: "normal",
  messageDensity: "cosy",
};

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;

const FONT_STACKS: Record<Exclude<FontPreset, "custom">, string> = {
  "roboto-mono": "'Roboto Mono', monospace",
  "system-mono":
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  "system-sans":
    "system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, Cantarell, 'Noto Sans', sans-serif",
  "system-serif": "Georgia, 'Times New Roman', 'Noto Serif', serif",
};

const LINE_HEIGHTS: Record<LineSpacing, string> = {
  compact: "1.3",
  normal: "1.5",
  relaxed: "1.75",
};

// A family name is only letters, digits, spaces and a few punctuation marks;
// anything else (quotes, parentheses, semicolons, at-signs) could turn the
// value into a different CSS declaration, so it is ignored.
const SAFE_FAMILY = /^[\p{L}\p{N} _.-]{1,64}$/u;

export function resolveFontFamily(preset: FontPreset, custom: string): string {
  if (preset !== "custom") {
    return FONT_STACKS[preset] ?? FONT_STACKS["roboto-mono"];
  }
  const name = custom.trim();
  if (!SAFE_FAMILY.test(name)) return FONT_STACKS["roboto-mono"];
  const generic = /mono|code|consol|courier/i.test(name)
    ? "monospace"
    : "sans-serif";
  return `'${name}', ${generic}`;
}

interface RootLike {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TYPOGRAPHY.fontSize;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

export function applyTypography(
  settings: Partial<TypographySettings>,
  root: RootLike = document.documentElement,
): void {
  const t = { ...DEFAULT_TYPOGRAPHY, ...settings };
  root.style.setProperty(
    "--obby-font-ui",
    resolveFontFamily(t.fontFamily, t.fontFamilyCustom),
  );
  root.style.setProperty(
    "--obby-font-chat",
    resolveFontFamily(t.chatFontFamily, t.chatFontFamilyCustom),
  );
  root.style.setProperty("--obby-font-size", `${clampFontSize(t.fontSize)}px`);
  root.style.setProperty(
    "--obby-line-height",
    LINE_HEIGHTS[t.lineSpacing] ?? LINE_HEIGHTS.normal,
  );
  root.setAttribute(
    "data-density",
    t.messageDensity === "compact" ? "compact" : "cosy",
  );
}
