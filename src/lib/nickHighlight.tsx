import React from "react";
import type { User } from "../types";
import { getColorStyle } from "./ircUtils";

// Characters RFC 2812 allows in a nickname. A run of them is one candidate
// token, so "bob:", "@bob" and "bob's" all still find "bob".
const NICK_TOKEN_RX = /[A-Za-z0-9[\]\\`^{}|_-]+/g;

// Elements whose text must stay verbatim: link targets and code.
const OPAQUE_TAGS = new Set(["a", "code", "pre"]);

export interface NickMatcher {
  // lowercased nick -> colour from the user's metadata, if any
  others: Map<string, string | undefined>;
  selfNick?: string;
  // custom mention words/phrases, already lowercased
  selfWords: string[];
}

// One map per member list, shared by every message rendered from it.
const memberMapCache = new WeakMap<
  readonly User[],
  Map<string, string | undefined>
>();

function memberMap(users: readonly User[]): Map<string, string | undefined> {
  let map = memberMapCache.get(users);
  if (!map) {
    map = new Map();
    for (const u of users) {
      // One-letter nicks would light up every lone "a" or "I".
      if (u.username.length < 2) continue;
      map.set(u.username.toLowerCase(), u.metadata?.color?.value);
    }
    memberMapCache.set(users, map);
  }
  return map;
}

export function buildNickMatcher(
  users: readonly User[],
  selfNick: string | undefined,
  customMentions: readonly string[] = [],
): NickMatcher {
  return {
    others: memberMap(users),
    selfNick: selfNick?.toLowerCase(),
    selfWords: customMentions
      .map((m) => m.trim().toLowerCase())
      .filter((m) => m.length > 0),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Segment {
  text: string;
  kind: "plain" | "self" | "other";
  color?: string;
}

function isNickChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9[\]\\`^{}|_-]/.test(ch);
}

function splitNickTokens(
  text: string,
  matcher: NickMatcher,
  out: Segment[],
): void {
  let last = 0;
  for (const m of text.matchAll(NICK_TOKEN_RX)) {
    const lower = m[0].toLowerCase();
    const isSelf = lower === matcher.selfNick;
    if (!isSelf && !matcher.others.has(lower)) continue;
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx), kind: "plain" });
    out.push(
      isSelf
        ? { text: m[0], kind: "self" }
        : { text: m[0], kind: "other", color: matcher.others.get(lower) },
    );
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: "plain" });
}

export function segmentText(text: string, matcher: NickMatcher): Segment[] {
  const out: Segment[] = [];
  if (matcher.selfWords.length === 0) {
    splitNickTokens(text, matcher, out);
    return out;
  }
  const wordsRx = new RegExp(
    matcher.selfWords.map(escapeRegExp).join("|"),
    "gi",
  );
  let last = 0;
  for (const m of text.matchAll(wordsRx)) {
    const idx = m.index ?? 0;
    const end = idx + m[0].length;
    // Whole words only, so a custom mention of "cat" leaves "concatenate" be.
    if (isNickChar(text[idx - 1]) || isNickChar(text[end])) continue;
    if (idx > last) splitNickTokens(text.slice(last, idx), matcher, out);
    out.push({ text: m[0], kind: "self" });
    last = end;
  }
  if (last < text.length) splitNickTokens(text.slice(last), matcher, out);
  return out;
}

function renderSegments(
  segments: Segment[],
  keyPrefix: string,
): React.ReactNode[] {
  return segments.map((seg, i) => {
    const key = `${keyPrefix}-nh${i}`;
    if (seg.kind === "self") {
      return (
        <span key={key} className="obby-mention-self">
          {seg.text}
        </span>
      );
    }
    if (seg.kind === "other") {
      return (
        <span
          key={key}
          className="font-bold text-white"
          style={getColorStyle(seg.color)}
        >
          {seg.text}
        </span>
      );
    }
    return seg.text;
  });
}

// Wraps nicknames found in rendered message text. Only plain strings inside
// host elements and fragments are touched; links, code and anything rendered
// by a component (markdown, emoji) pass through unchanged.
export function highlightNicks(
  node: React.ReactNode,
  matcher: NickMatcher,
): { node: React.ReactNode; mentionsSelf: boolean } {
  let mentionsSelf = false;
  let counter = 0;

  const walk = (n: React.ReactNode): React.ReactNode => {
    if (typeof n === "string") {
      const segments = segmentText(n, matcher);
      if (segments.every((s) => s.kind === "plain")) return n;
      if (segments.some((s) => s.kind === "self")) mentionsSelf = true;
      return renderSegments(segments, `t${counter++}`);
    }
    if (Array.isArray(n)) return n.map(walk);
    if (!React.isValidElement(n)) return n;
    const isFragment = n.type === React.Fragment;
    if (!isFragment && typeof n.type !== "string") return n;
    if (!isFragment && OPAQUE_TAGS.has(n.type as string)) return n;
    const props = n.props as { children?: React.ReactNode };
    if (props.children === undefined) return n;
    const children = walk(props.children);
    return React.cloneElement(n, undefined, children);
  };

  return { node: walk(node), mentionsSelf };
}
