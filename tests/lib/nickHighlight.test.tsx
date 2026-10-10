import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mircToHtml } from "../../src/lib/ircUtils";
import {
  buildNickMatcher,
  containsWholeWord,
  highlightNicks,
  segmentText,
} from "../../src/lib/nickHighlight";
import { shouldPlayNotificationSound } from "../../src/lib/notificationSounds";
import { checkForMention, extractMentions } from "../../src/lib/notifications";
import type { GlobalSettings } from "../../src/store";
import type { User } from "../../src/types";

const users: User[] = [
  { id: "1", username: "bob", isOnline: true },
  {
    id: "2",
    username: "Carol[m]",
    isOnline: true,
    metadata: { color: { value: "#ff0000", visibility: "public" } },
  },
  { id: "3", username: "x", isOnline: true },
  { id: "4", username: "me", isOnline: true },
];

function html(text: string, self?: string, custom: string[] = []) {
  const out = highlightNicks(
    mircToHtml(text, "k"),
    buildNickMatcher(users, {
      ownNick: self,
      highlightSelf: self !== undefined,
      customMentions: custom,
    }),
  );
  return { html: renderToStaticMarkup(out.node), ...out };
}

describe("segmentText", () => {
  const matcher = buildNickMatcher(users, {
    ownNick: "me",
    highlightSelf: true,
    customMentions: ["pizza night"],
  });

  it("finds member nicks case-insensitively with punctuation around them", () => {
    const segs = segmentText("BOB: hi @carol[m], bob's turn", matcher);
    expect(segs.filter((s) => s.kind === "other").map((s) => s.text)).toEqual([
      "BOB",
      "carol[m]",
      "bob",
    ]);
  });

  it("does not match nicks inside longer words", () => {
    const segs = segmentText("bobby and kebob", matcher);
    expect(segs.every((s) => s.kind === "plain")).toBe(true);
  });

  it("skips one-letter nicks", () => {
    expect(segmentText("x marks the spot", matcher)).toEqual([
      { text: "x marks the spot", kind: "plain" },
    ]);
  });

  it("marks our own nick and whole-word custom mentions as self", () => {
    const segs = segmentText("me? Pizza Night! not pizza nightly", matcher);
    expect(segs.filter((s) => s.kind === "self").map((s) => s.text)).toEqual([
      "me",
      "Pizza Night",
    ]);
  });
});

describe("highlightNicks", () => {
  it("bolds other nicks in their metadata colour", () => {
    const r = html("hi Carol[m]");
    expect(r.html).toContain(
      '<span class="font-bold text-white" style="color:#ff0000">Carol[m]</span>',
    );
    expect(r.mentionsSelf).toBe(false);
  });

  it("pills our own nick and reports the mention", () => {
    const r = html("hey me, look", "me");
    expect(r.html).toContain('<span class="obby-mention-self">me</span>');
    expect(r.mentionsSelf).toBe(true);
  });

  it("without a self nick, our name is just another member", () => {
    const r = html("hey me", undefined);
    expect(r.html).not.toContain("obby-mention-self");
    expect(r.html).toContain('<span class="font-bold text-white">me</span>');
    expect(r.mentionsSelf).toBe(false);
  });

  it("leaves link text untouched", () => {
    const r = html("see https://example.com/bob for bob", "me");
    expect(r.html).toContain(">https://example.com/bob</a>");
    expect(r.html).toContain('<span class="font-bold text-white">bob</span>');
  });

  it("keeps mIRC formatting around a highlighted nick", () => {
    const r = html("\x02bold bob\x02");
    expect(r.html).toContain("font-weight:bold");
    expect(r.html).toContain('<span class="font-bold text-white">bob</span>');
  });

  it("returns text without nicks unchanged", () => {
    const node = mircToHtml("nothing to see", "k");
    const out = highlightNicks(
      node,
      buildNickMatcher(users, { ownNick: "me", highlightSelf: true }),
    );
    expect(renderToStaticMarkup(out.node)).toBe(renderToStaticMarkup(node));
  });
});

describe("clickable nicks", () => {
  function renderClickable(text: string, highlightSelf = false) {
    const onNickClick = vi.fn();
    const out = highlightNicks(
      mircToHtml(text, "k"),
      buildNickMatcher(users, { ownNick: "me", highlightSelf, onNickClick }),
    );
    render(<div>{out.node}</div>);
    return onNickClick;
  }

  it("clicking a member's nick reports their server spelling", () => {
    const onNickClick = renderClickable("ask carol[m] about it");
    fireEvent.click(screen.getByRole("button", { name: "carol[m]" }));
    expect(onNickClick).toHaveBeenCalledWith("Carol[m]");
  });

  it("our own nick is never a button, highlighted or not", () => {
    renderClickable("me and bob");
    expect(screen.queryByRole("button", { name: "me" })).toBeNull();
    expect(screen.getByRole("button", { name: "bob" })).toBeDefined();
  });

  it("our highlighted nick stays a plain pill", () => {
    renderClickable("hey me", true);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("whole-word mentions (sound, red dot, highlight agree)", () => {
  const me: User = { id: "me", username: "bob", isOnline: true };
  const settings = {
    customMentions: ["pizza"],
    enableHighlights: true,
    enableNotificationSounds: true,
    notificationSound: "",
  } as unknown as GlobalSettings;

  it.each([
    "bob!",
    "hey bob",
    "@bob",
    "bob: hi",
    "BOB?",
    "(bob)",
  ])("%s mentions bob", (text) => {
    expect(containsWholeWord(text, "bob")).toBe(true);
    expect(checkForMention(text, me, settings)).toBe(true);
  });

  it.each([
    "bobby",
    "kebob",
    "bob_",
    "bob2",
    "[bob]x",
  ])("%s does not mention bob", (text) => {
    expect(containsWholeWord(text, "bob")).toBe(false);
    expect(checkForMention(text, me, settings)).toBe(false);
  });

  it("custom mentions are whole words too", () => {
    expect(checkForMention("pizza time", me, settings)).toBe(true);
    expect(checkForMention("pizzas", me, settings)).toBe(false);
    expect(extractMentions("bob, pizza?", me, settings)).toEqual([
      "bob",
      "pizza",
    ]);
  });

  it("the notification sound uses the same rule", () => {
    const msg = (content: string) => ({
      type: "message" as const,
      userId: "carol",
      content,
    });
    expect(
      shouldPlayNotificationSound(msg("bob!") as never, me, settings),
    ).toBe(true);
    expect(
      shouldPlayNotificationSound(msg("bobby") as never, me, settings),
    ).toBe(false);
  });
});
