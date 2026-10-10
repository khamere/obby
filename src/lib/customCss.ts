import { useSyncExternalStore } from "react";

// A user stylesheet applied on top of the app (themes, fonts, per-network
// styling via the sidebar's data-network-host attribute, ...). It is set from
// Settings, kept in this browser, and also uploaded next to the app
// (data/custom.css) so every other browser picks it up. The upload only works
// where the deployment allows PUT on that path (see docs/custom-css.md);
// otherwise the stylesheet stays local to this browser.
//
// Anything that could make the browser fetch from elsewhere (@import, remote
// url()s, image-set) is removed, so a stylesheet can never leak the user's IP.

export const SHARED_CSS_PATH = "data/custom.css";
const LOCAL_KEY = "obby.customCss";
// Set when this browser's last save couldn't reach the server, so that save
// keeps applying here instead of an older server copy.
const LOCAL_ONLY_KEY = "obby.customCss.localOnly";
const STYLE_ID = "obby-custom-css";
export const MAX_CSS_CHARS = 5_000_000;

export interface CustomCssState {
  css: string;
  source: "server" | "local" | "none";
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

export function sanitizeCss(input: string): string {
  return (
    decodeLetterEscapes(input)
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

// ---- store ------------------------------------------------------------------

let local: string | null = null;
let shared: string | null = null;
let localOnly = false;
let state: CustomCssState = { css: "", source: "none" };
const listeners = new Set<() => void>();

function applyToDocument(css: string): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
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

function recompute(): void {
  // The server copy is authoritative (a change made in another browser
  // applies here too) unless this browser's own save never reached it.
  const useLocal = local !== null && (localOnly || shared === null);
  const css = (useLocal ? local : shared) ?? "";
  state = css.trim()
    ? { css, source: useLocal ? "local" : "server" }
    : { css: "", source: "none" };
  applyToDocument(state.css);
  for (const l of listeners) l();
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // quota or storage disabled: the server copy still works
  }
}

async function fetchShared(): Promise<string | null> {
  try {
    const res = await fetch(SHARED_CSS_PATH, { cache: "no-cache" });
    if (!res.ok) return null;
    const text = await res.text();
    // An SPA fallback answers unknown paths with index.html.
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("css") || /^\s*<(!doctype|html)/i.test(text)) {
      return null;
    }
    return sanitizeCss(text);
  } catch {
    return null;
  }
}

async function putShared(css: string): Promise<boolean> {
  try {
    const res = await fetch(SHARED_CSS_PATH, {
      method: "PUT",
      headers: { "Content-Type": "text/css" },
      body: css,
    });
    return res.ok;
  } catch {
    return false;
  }
}

let loaded = false;
export function loadCustomCss(): void {
  if (loaded) return;
  loaded = true;
  const stored = storageGet(LOCAL_KEY);
  local = stored === null ? null : sanitizeCss(stored);
  localOnly = storageGet(LOCAL_ONLY_KEY) === "1";
  recompute();
  void fetchShared().then((css) => {
    shared = css;
    recompute();
  });
}

// Saves (or, with an empty string, removes) the custom stylesheet for this
// browser and tries to store it on the server for every other browser.
export async function saveCustomCss(
  input: string,
): Promise<{ savedOnServer: boolean }> {
  if (input.length > MAX_CSS_CHARS) throw new Error("too-large");
  const css = sanitizeCss(input);
  local = css.trim() ? css : null;
  storageSet(LOCAL_KEY, local);
  const savedOnServer = await putShared(css.trim() ? css : "");
  if (savedOnServer) shared = css.trim() ? css : "";
  localOnly = !savedOnServer && local !== null;
  storageSet(LOCAL_ONLY_KEY, localOnly ? "1" : null);
  recompute();
  return { savedOnServer };
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
  local = null;
  shared = null;
  localOnly = false;
  loaded = false;
  state = { css: "", source: "none" };
  applyToDocument("");
}
