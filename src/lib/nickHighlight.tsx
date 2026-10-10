import React from "react";
import type { User } from "../types";
import { getColorStyle } from "./ircUtils";

// Characters RFC 2812 allows in a nickname. A run of them is one candidate
// token, so "bob:", "@bob" and "bob's" all still find "bob".
const NICK_TOKEN_RX = /[A-Za-z0-9[\]\\`^{}|_-]+/g;

// Elements whose text must stay verbatim (link targets, code) or that are
// already interactive.
const OPAQUE_TAGS = new Set(["a", "button", "code", "pre"]);

interface Member {
  // the server's spelling, used when acting on the nick
  nick: string;
  color?: string;
}

export interface NickMatcher {
  // keyed by lowercased nick
  others: Map<string, Member>;
  // our nick when it should be highlighted as a mention, lowercased
  selfNick?: string;
  // our nick regardless of highlighting, lowercased; never clickable
  ownNick?: string;
  // custom mention words/phrases, already lowercased
  selfWords: string[];
  onNickClick?: (nick: string) => void;
}

export interface NickMatcherOptions {
  ownNick?: string;
  // highlight our own nick and the custom mentions as pings
  highlightSelf?: boolean;
  customMentions?: readonly string[];
  onNickClick?: (nick: string) => void;
}

// One map per member list, shared by every message rendered from it.
const memberMapCache = new WeakMap<readonly User[], Map<string, Member>>();

function memberMap(users: readonly User[]): Map<string, Member> {
  let map = memberMapCache.get(users);
  if (!map) {
    map = new Map();
    for (const u of users) {
      // One-letter nicks would light up every lone "a" or "I".
      if (u.username.length < 2) continue;
      map.set(u.username.toLowerCase(), {
        nick: u.username,
        color: u.metadata?.color?.value,
      });
    }
    memberMapCache.set(users, map);
  }
  return map;
}

export function buildNickMatcher(
  users: readonly User[],
  {
    ownNick,
    highlightSelf = false,
    customMentions = [],
    onNickClick,
  }: NickMatcherOptions = {},
): NickMatcher {
  const own = ownNick?.toLowerCase();
  return {
    others: memberMap(users),
    selfNick: highlightSelf ? own : undefined,
    ownNick: own,
    selfWords: highlightSelf
      ? customMentions
          .map((m) => m.trim().toLowerCase())
          .filter((m) => m.length > 0)
      : [],
    onNickClick,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Segment {
  text: string;
  kind: "plain" | "self" | "other";
  member?: Member;
}

function isNickChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9[\]\\`^{}|_-]/.test(ch);
}

// True when `word` appears in `text` with no nick character directly before
// or after it, ignoring case: "bob!", "@bob" and "bob:" mention bob, "bobby"
// doesn't. Shared by the highlighting and the notification/mention checks so
// they always agree.
export function containsWholeWord(text: string, word: string): boolean {
  const needle = word.trim().toLowerCase();
  if (!needle) return false;
  const haystack = text.toLowerCase();
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + 1)
  ) {
    if (
      !isNickChar(haystack[i - 1]) &&
      !isNickChar(haystack[i + needle.length])
    )
      return true;
  }
  return false;
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
        : { text: m[0], kind: "other", member: matcher.others.get(lower) },
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
  matcher: NickMatcher,
): React.ReactNode[] {
  const { onNickClick, ownNick } = matcher;
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
      const style = getColorStyle(seg.member?.color);
      const nick = seg.member?.nick ?? seg.text;
      if (!onNickClick || nick.toLowerCase() === ownNick) {
        return (
          <span key={key} className="font-bold text-white" style={style}>
            {seg.text}
          </span>
        );
      }
      return (
        <button
          key={key}
          type="button"
          className="obby-nick-link font-bold text-white"
          style={style}
          title={nick}
          onClick={(e) => {
            // The row has its own click/long-press handling.
            e.stopPropagation();
            onNickClick(nick);
          }}
        >
          {seg.text}
        </button>
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
      return renderSegments(segments, `t${counter++}`, matcher);
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
