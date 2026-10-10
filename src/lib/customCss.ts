import { useSyncExternalStore } from "react";

// A user stylesheet applied on top of the app (themes, fonts, per-network
// styling via the sidebar's data-network-host attribute, ...). Two sources,
// both kept in this browser:
//   - linked: a CSS file at a URL the user chose, fetched at startup so
//     everyone who uses the same link gets updates; the last good copy is
//     cached so it applies immediately and survives the host being down.
//   - own: CSS pasted or uploaded in Settings, applied after the linked file
//     so personal tweaks win.
//
// Everything is sanitised: @import, remote url()s and other functions that
// take a URL are removed, so a stylesheet can never make the browser fetch
// anything. The only request is the one for the link itself, which the user
// opts into.

const OWN_KEY = "obby.customCss";
const LINK_KEY = "obby.customCss.link";
const LINK_CACHE_KEY = "obby.customCss.linkCache";
const STYLE_ID = "obby-custom-css";
export const MAX_CSS_CHARS = 5_000_000;

export type LinkStatus = "none" | "loading" | "ok" | "cached" | "error";

export interface CustomCssState {
  own: string;
  link: string;
  linkCss: string;
  linkStatus: LinkStatus;
}

// ---- sanitising -------------------------------------------------------------

// CSS escapes can spell "url(" or "@import" without those letters appearing
// ("\75 rl(", "u\rl("). Decoding escapes that yield ASCII letters, "-" or
// "(" keeps the stylesheet's meaning but lets the filters below see them.
function decodeLetterEscapes(css: string): string {
  return css
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (match, hex: string) => {
      const ch = String.fromCodePoint(Number.parseInt(hex, 16));
      return /^[A-Za-z(-]$/.test(ch) ? ch : match;
    })
    .replace(/\\([g-zG-Z(-])/g, "$1");
}

// The browser's own preprocessing (CSS Syntax §3.3): CRLF, CR and FF become LF
// and NUL becomes U+FFFD. Without it, "\75\r\nrl(" reads as "url(" to the
// browser but the escape decoder above would leave a stray "\n".
function preprocess(css: string): string {
  return css.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�");
}

export function sanitizeCss(input: string): string {
  return (
    decodeLetterEscapes(preprocess(input))
      // closing the <style> element would let the rest escape as markup
      .replace(/<\/style/gi, "<\\/style")
      // @import pulls in another (remote) stylesheet
      .replace(/@import\b[^;]*;?/gi, "")
      // only inline data: URLs may be referenced
      .replace(
        /url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi,
        (match, _q: string, target: string) =>
          /^data:/i.test(target.trim()) ? match : "none",
      )
      // functions that accept a bare string as a URL: image-set("x"),
      // image("x"), src("x"). Only the call is matched, not the `src:`
      // descriptor in @font-face.
      .replace(
        /(^|[^\w-])(-webkit-)?(image-set|image|src)\(/gi,
        "$1invalid-url-fn(",
      )
      // legacy script/binding hooks
      .replace(/expression\s*\(|-moz-binding|behavior\s*:/gi, "invalid:")
  );
}

export function isValidCssLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// ---- store ------------------------------------------------------------------

let state: CustomCssState = {
  own: "",
  link: "",
  linkCss: "",
  linkStatus: "none",
};
const listeners = new Set<() => void>();

function storageGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // quota or storage disabled: still applies for this session
  }
}

function applyToDocument(css: string): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css.trim()) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    // last in <head> so it overrides the app's own styles
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

function update(patch: Partial<CustomCssState>): void {
  state = { ...state, ...patch };
  // linked file first, own CSS last so it wins
  applyToDocument([state.linkCss, state.own].filter(Boolean).join("\n\n"));
  for (const l of listeners) l();
}

async function fetchLink(link: string): Promise<string> {
  const res = await fetch(link, {
    cache: "no-cache",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CSS_CHARS) throw new Error("too-large");
  // a file host's preview page instead of the raw file
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("not-css");
  return sanitizeCss(text);
}

let refreshSeq = 0;
async function refreshLink(): Promise<void> {
  const link = state.link;
  if (!link) return;
  const seq = ++refreshSeq;
  update({ linkStatus: state.linkCss ? "cached" : "loading" });
  try {
    const css = await fetchLink(link);
    if (seq !== refreshSeq) return;
    storageSet(LINK_CACHE_KEY, css);
    update({ linkCss: css, linkStatus: "ok" });
  } catch {
    if (seq !== refreshSeq) return;
    update({ linkStatus: state.linkCss ? "cached" : "error" });
  }
}

let loaded = false;
export function loadCustomCss(): void {
  if (loaded) return;
  loaded = true;
  const link = storageGet(LINK_KEY);
  update({
    own: sanitizeCss(storageGet(OWN_KEY)),
    link,
    linkCss: link ? sanitizeCss(storageGet(LINK_CACHE_KEY)) : "",
    linkStatus: link ? "cached" : "none",
  });
  void refreshLink();
}

/** Saves (or, with "", removes) the user's own pasted/uploaded CSS. */
export function saveOwnCss(input: string): void {
  if (input.length > MAX_CSS_CHARS) throw new Error("too-large");
  const own = sanitizeCss(input);
  storageSet(OWN_KEY, own);
  update({ own });
}

/**
 * Sets (or, with "", removes) the linked stylesheet and loads it. Resolves
 * once the first fetch has finished; check `linkStatus` for the outcome.
 */
export async function setCssLink(input: string): Promise<void> {
  const link = input.trim();
  if (link && !isValidCssLink(link)) throw new Error("bad-link");
  storageSet(LINK_KEY, link);
  storageSet(LINK_CACHE_KEY, "");
  refreshSeq++;
  update({ link, linkCss: "", linkStatus: link ? "loading" : "none" });
  await refreshLink();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCustomCssState(): CustomCssState {
  return state;
}

export function useCustomCssState(): CustomCssState {
  return useSyncExternalStore(subscribe, getCustomCssState);
}

// test hook
export function resetCustomCssForTests(): void {
  loaded = false;
  refreshSeq++;
  state = { own: "", link: "", linkCss: "", linkStatus: "none" };
  applyToDocument("");
}
