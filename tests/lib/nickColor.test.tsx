import { renderHook } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { mircToHtml } from "../../src/lib/ircUtils";
import {
  NICK_COLOR_COUNT,
  nickColor,
  nickColorIndex,
  useNickColor,
} from "../../src/lib/nickColor";
import { buildNickMatcher, highlightNicks } from "../../src/lib/nickHighlight";
import useStore from "../../src/store";
import type { User } from "../../src/types";

function setColored(on: boolean) {
  useStore.setState((s) => ({
    globalSettings: { ...s.globalSettings, coloredNicknames: on },
  }));
}

describe("nickColorIndex", () => {
  it("is stable and ignores case", () => {
    expect(nickColorIndex("Bob")).toBe(nickColorIndex("bob"));
    expect(nickColorIndex("bob")).toBe(nickColorIndex("bob"));
  });

  it("stays in range and spreads nicks over the palette", () => {
    const used = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const idx = nickColorIndex(`user${i}`);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(NICK_COLOR_COUNT);
      used.add(idx);
    }
    expect(used.size).toBe(NICK_COLOR_COUNT);
  });

  it("refers to the CSS palette", () => {
    expect(nickColor("bob")).toBe(`var(--obby-nick-${nickColorIndex("bob")})`);
  });
});

describe("useNickColor", () => {
  afterEach(() => setColored(false));

  it("is off by default", () => {
    setColored(false);
    const { result } = renderHook(() => useNickColor("bob"));
    expect(result.current).toBeUndefined();
  });

  it("colours a nick when the setting is on", () => {
    setColored(true);
    const { result } = renderHook(() => useNickColor("bob"));
    expect(result.current).toBe(nickColor("bob"));
  });

  it("a colour the user chose themselves always wins", () => {
    setColored(true);
    const { result } = renderHook(() => useNickColor("bob", "#123456"));
    expect(result.current).toBe("#123456");
  });
});

describe("nicks inside messages", () => {
  const users: User[] = [
    { id: "1", username: "bob", isOnline: true },
    {
      id: "2",
      username: "carol",
      isOnline: true,
      metadata: { color: { value: "#ff0000", visibility: "public" } },
    },
  ];

  it("uses the nick colour, but a metadata colour first", () => {
    const out = highlightNicks(
      mircToHtml("bob and carol", "k"),
      buildNickMatcher(users, { colorFor: nickColor }),
    );
    const html = renderToStaticMarkup(out.node);
    expect(html).toContain(`color:${nickColor("bob")}`);
    expect(html).toContain("color:#ff0000");
  });
});
