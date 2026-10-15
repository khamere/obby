// A theme shared by link: the URL of a theme JSON file, fetched at startup
// without cookies or referrer (same stance as the custom CSS link), validated
// by lib/theme (only colours can get through) and cached so the last good
// copy still applies when the host is down.

import { useSyncExternalStore } from "react";
import { type ThemeDefinition, validateTheme } from "./theme";

const LINK_KEY = "obby.themeLink";
const CACHE_KEY = "obby.themeLink.cache";
export const MAX_THEME_CHARS = 64_000;

export type ThemeLinkStatus = "none" | "loading" | "ok" | "cached" | "error";

export interface ThemeLinkState {
  link: string;
  theme: ThemeDefinition | null;
  status: ThemeLinkStatus;
}

let state: ThemeLinkState = { link: "", theme: null, status: "none" };
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
    // storage unavailable: still applies for this session
  }
}

function update(patch: Partial<ThemeLinkState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function isValidThemeLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function fetchTheme(link: string): Promise<ThemeDefinition> {
  const res = await fetch(link, {
    cache: "no-cache",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const text = await res.text();
  if (text.length > MAX_THEME_CHARS) throw new Error("too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not-json");
  }
  const theme = validateTheme(parsed);
  if (!theme) throw new Error("not-a-theme");
  return theme;
}

let refreshSeq = 0;
async function refresh(): Promise<void> {
  const link = state.link;
  if (!link) return;
  const seq = ++refreshSeq;
  update({ status: state.theme ? "cached" : "loading" });
  try {
    const theme = await fetchTheme(link);
    if (seq !== refreshSeq) return;
    storageSet(CACHE_KEY, JSON.stringify(theme));
    update({ theme, status: "ok" });
  } catch {
    if (seq !== refreshSeq) return;
    update({ status: state.theme ? "cached" : "error" });
  }
}

function readCache(): ThemeDefinition | null {
  const raw = storageGet(CACHE_KEY);
  if (!raw) return null;
  try {
    return validateTheme(JSON.parse(raw));
  } catch {
    return null;
  }
}

let loaded = false;
export function loadThemeLink(): void {
  if (loaded) return;
  loaded = true;
  const link = storageGet(LINK_KEY);
  const theme = link ? readCache() : null;
  update({
    link,
    theme,
    status: link ? (theme ? "cached" : "loading") : "none",
  });
  void refresh();
}

/** Sets (or, with "", removes) the theme link and loads it. */
export async function setThemeLink(input: string): Promise<void> {
  const link = input.trim();
  if (link && !isValidThemeLink(link)) throw new Error("bad-link");
  storageSet(LINK_KEY, link);
  storageSet(CACHE_KEY, "");
  refreshSeq++;
  update({ link, theme: null, status: link ? "loading" : "none" });
  await refresh();
}

export function subscribeThemeLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getThemeLinkState(): ThemeLinkState {
  return state;
}

export function useThemeLinkState(): ThemeLinkState {
  return useSyncExternalStore(subscribeThemeLink, getThemeLinkState);
}

export function resetThemeLinkForTests(): void {
  state = { link: "", theme: null, status: "none" };
  loaded = false;
  refreshSeq++;
}
