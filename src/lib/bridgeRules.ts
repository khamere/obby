import { useSyncExternalStore } from "react";
import {
  type BridgeMatch,
  compileTemplate,
  matchTemplate,
} from "./bridgeTemplates";
import { isValidCssLink, type LinkStatus } from "./customCss";
import { stripIrcFormatting } from "./messageFormatter";

// Bridge rules say which bot relays a tracker's shoutbox into which IRC
// network and how it wraps the person's name, so a relayed line can be shown
// as that person. Two sources, both kept in this browser, exactly like the
// custom stylesheet:
//   - linked: a JSON file at a URL the user chose, fetched at startup so
//     everyone who uses the same link gets updates; the last good copy is
//     cached so it applies immediately and survives the host being down.
//   - own: JSON pasted or uploaded in Settings; its rules replace linked
//     rules for the same host and bot.
//
// Rules are templates, never regular expressions (see bridgeTemplates.ts),
// and the only request is the one for the link itself.

export const MAX_RULES_CHARS = 1_000_000;
export const MAX_RULES = 500;
export const MAX_LABEL_CHARS = 32;

export interface BridgeRule {
  host: string;
  bot?: string;
  channels?: string[];
  formats?: string[];
  nickFormat?: string;
  label?: string;
  note?: string;
}

export interface ParsedBridgeRules {
  rules: BridgeRule[];
  skipped: number;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

function validRule(raw: unknown): BridgeRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.host !== "string" || !r.host.trim()) return null;
  if (r.channels !== undefined && !isStringArray(r.channels)) return null;
  // The marker is mandatory, so a label that would render as nothing is refused.
  if (r.label !== undefined) {
    if (typeof r.label !== "string") return null;
    const label = r.label.trim();
    if (!label || label.length > MAX_LABEL_CHARS) return null;
  }
  const hasBot = r.bot !== undefined || r.formats !== undefined;
  const hasNick = r.nickFormat !== undefined;
  if (hasBot === hasNick) return null;
  const rule: BridgeRule = { host: r.host };
  if (r.channels) rule.channels = r.channels as string[];
  if (typeof r.label === "string") rule.label = r.label.trim();
  if (typeof r.note === "string") rule.note = r.note;
  if (hasBot) {
    if (typeof r.bot !== "string" || !r.bot.trim()) return null;
    if (!isStringArray(r.formats) || r.formats.length === 0) return null;
    if (r.formats.some((f) => !compileTemplate(f, "message"))) return null;
    rule.bot = r.bot;
    rule.formats = r.formats;
  } else {
    if (typeof r.nickFormat !== "string") return null;
    if (!compileTemplate(r.nickFormat, "nick")) return null;
    rule.nickFormat = r.nickFormat;
  }
  return rule;
}

/**
 * Parses a rules file. Throws "too-large", "bad-json", "bad-version" or
 * "too-many-rules" when the whole file is unusable; a single bad rule is
 * skipped and counted instead.
 */
export function parseBridgeRules(json: string): ParsedBridgeRules {
  if (json.length > MAX_RULES_CHARS) throw new Error("too-large");
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("bad-json");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("bad-json");
  }
  const { version, rules } = data as { version?: unknown; rules?: unknown };
  if (version !== 1) throw new Error("bad-version");
  if (!Array.isArray(rules)) throw new Error("bad-json");
  if (rules.length > MAX_RULES) throw new Error("too-many-rules");
  const good: BridgeRule[] = [];
  let skipped = 0;
  for (const raw of rules) {
    const rule = validRule(raw);
    if (rule) good.push(rule);
    else skipped++;
  }
  return { rules: good, skipped };
}

const ruleKey = (rule: BridgeRule): string =>
  `${rule.host.toLowerCase()}\0${rule.bot?.toLowerCase() ?? "nick"}`;

/** Own rules replace linked rules for the same host and bot. */
export function mergeBridgeRules(
  linked: BridgeRule[],
  own: BridgeRule[],
): BridgeRule[] {
  const overridden = new Set(own.map(ruleKey));
  return [...linked.filter((r) => !overridden.has(ruleKey(r))), ...own];
}

interface CompiledBot {
  via: string;
  channels?: Set<string>;
  formats: RegExp[];
}

interface CompiledNick {
  via: string;
  channels?: Set<string>;
  re: RegExp;
}

interface HostRules {
  bots: Map<string, CompiledBot[]>;
  nicks: CompiledNick[];
}

export interface CompiledRules {
  byHost: Map<string, HostRules>;
}

export const EMPTY_RULES: CompiledRules = { byHost: new Map() };

const channelSet = (rule: BridgeRule): Set<string> | undefined =>
  rule.channels
    ? new Set(rule.channels.map((c) => c.toLowerCase()))
    : undefined;

export function compileBridgeRules(rules: BridgeRule[]): CompiledRules {
  const byHost = new Map<string, HostRules>();
  for (const rule of rules) {
    const host = rule.host.toLowerCase();
    let entry = byHost.get(host);
    if (!entry) {
      entry = { bots: new Map(), nicks: [] };
      byHost.set(host, entry);
    }
    if (rule.bot && rule.formats) {
      const formats = rule.formats
        .map((f) => compileTemplate(f, "message"))
        .filter((re): re is RegExp => re !== null);
      const bot = rule.bot.toLowerCase();
      const list = entry.bots.get(bot) ?? [];
      list.push({ via: rule.bot, channels: channelSet(rule), formats });
      entry.bots.set(bot, list);
    } else if (rule.nickFormat) {
      const re = compileTemplate(rule.nickFormat, "nick");
      if (re) {
        entry.nicks.push({
          via: rule.label ?? "web",
          channels: channelSet(rule),
          re,
        });
      }
    }
  }
  return { byHost };
}

export type BridgeResult =
  | { kind: "bot"; nick: string; text: string; via: string }
  | { kind: "nick"; displayNick: string; via: string };

const MODE_PREFIXES = /^[~&@%+!]+/;

const inChannel = (channels: Set<string> | undefined, channel: string) =>
  !channels || channels.has(channel.toLowerCase());

/**
 * Finds the person behind a relayed line: the bot's own template match, or
 * the unwrapped nick of a web user who is on IRC under a wrapped name.
 */
export function applyBridgeRules(
  rules: CompiledRules,
  host: string,
  channel: string,
  sender: string,
  text: string,
): BridgeResult | null {
  const entry = rules.byHost.get(host.toLowerCase());
  if (!entry) return null;
  const nick = sender.replace(MODE_PREFIXES, "");
  const bots = entry.bots.get(nick.toLowerCase());
  if (bots) {
    const clean = stripIrcFormatting(text);
    for (const bot of bots) {
      if (!inChannel(bot.channels, channel)) continue;
      for (const re of bot.formats) {
        const found: BridgeMatch | null = matchTemplate(re, clean);
        if (found) {
          return {
            kind: "bot",
            nick: found.nick,
            text: found.text,
            via: bot.via,
          };
        }
      }
    }
  }
  for (const rule of entry.nicks) {
    if (!inChannel(rule.channels, channel)) continue;
    const found = matchTemplate(rule.re, nick);
    if (found) return { kind: "nick", displayNick: found.nick, via: rule.via };
  }
  return null;
}

// ---- store ------------------------------------------------------------------

const OWN_KEY = "obby.bridgeRules";
const LINK_KEY = "obby.bridgeRules.link";
const LINK_CACHE_KEY = "obby.bridgeRules.linkCache";

export interface BridgeRulesState {
  own: string;
  ownRules: ParsedBridgeRules;
  link: string;
  linkJson: string;
  linkRules: ParsedBridgeRules;
  linkStatus: LinkStatus;
}

const NO_RULES: ParsedBridgeRules = { rules: [], skipped: 0 };

let state: BridgeRulesState = {
  own: "",
  ownRules: NO_RULES,
  link: "",
  linkJson: "",
  linkRules: NO_RULES,
  linkStatus: "none",
};
let compiled: CompiledRules = EMPTY_RULES;
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

// A stored copy that no longer parses (an older format) counts as no rules.
function parseOrNone(json: string): ParsedBridgeRules {
  if (!json) return NO_RULES;
  try {
    return parseBridgeRules(json);
  } catch {
    return NO_RULES;
  }
}

function update(patch: Partial<BridgeRulesState>): void {
  state = { ...state, ...patch };
  compiled = compileBridgeRules(
    mergeBridgeRules(state.linkRules.rules, state.ownRules.rules),
  );
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
  if (text.length > MAX_RULES_CHARS) throw new Error("too-large");
  // a file host's preview page instead of the raw file
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("not-json");
  parseBridgeRules(text);
  return text;
}

let refreshSeq = 0;
async function refreshLink(): Promise<void> {
  const link = state.link;
  if (!link) return;
  const seq = ++refreshSeq;
  update({ linkStatus: state.linkJson ? "cached" : "loading" });
  try {
    const json = await fetchLink(link);
    if (seq !== refreshSeq) return;
    storageSet(LINK_CACHE_KEY, json);
    update({ linkJson: json, linkRules: parseOrNone(json), linkStatus: "ok" });
  } catch {
    if (seq !== refreshSeq) return;
    update({ linkStatus: state.linkJson ? "cached" : "error" });
  }
}

let loaded = false;
export function loadBridgeRules(): void {
  if (loaded) return;
  loaded = true;
  const link = storageGet(LINK_KEY);
  const own = storageGet(OWN_KEY);
  const linkJson = link ? storageGet(LINK_CACHE_KEY) : "";
  update({
    own,
    ownRules: parseOrNone(own),
    link,
    linkJson,
    linkRules: parseOrNone(linkJson),
    linkStatus: link ? "cached" : "none",
  });
  void refreshLink();
}

/** Saves (or, with "", removes) the user's own rules. Throws the parse errors. */
export function saveOwnBridgeRules(input: string): void {
  const own = input.trim();
  const ownRules = own ? parseBridgeRules(own) : NO_RULES;
  storageSet(OWN_KEY, own);
  update({ own, ownRules });
}

/**
 * Sets (or, with "", removes) the linked rules file and loads it. Resolves
 * once the first fetch has finished; check `linkStatus` for the outcome.
 */
export async function setBridgeRulesLink(input: string): Promise<void> {
  const link = input.trim();
  if (link && !isValidCssLink(link)) throw new Error("bad-link");
  storageSet(LINK_KEY, link);
  storageSet(LINK_CACHE_KEY, "");
  refreshSeq++;
  update({
    link,
    linkJson: "",
    linkRules: NO_RULES,
    linkStatus: link ? "loading" : "none",
  });
  await refreshLink();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBridgeRulesState(): BridgeRulesState {
  return state;
}

export function useBridgeRulesState(): BridgeRulesState {
  return useSyncExternalStore(subscribe, getBridgeRulesState);
}

/** The merged linked-plus-own rules, compiled; what the message handler uses. */
export function getCompiledBridgeRules(): CompiledRules {
  return compiled;
}

// test hook
export function resetBridgeRulesForTests(): void {
  loaded = false;
  refreshSeq++;
  state = {
    own: "",
    ownRules: NO_RULES,
    link: "",
    linkJson: "",
    linkRules: NO_RULES,
    linkStatus: "none",
  };
  compiled = EMPTY_RULES;
}
