import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mircToHtml } from "../../src/lib/ircUtils";
import {
  buildNickMatcher,
  findChannels,
  highlightNicks,
} from "../../src/lib/nickHighlight";
import type { User } from "../../src/types";

const names = (text: string) => findChannels(text).map((c) => c.name);

describe("findChannels", () => {
  it("finds channels at word starts and drops trailing punctuation", () => {
    expect(names("join #obby-dev, it's quiet")).toEqual(["#obby-dev"]);
    expect(names("(#help) or #lounge! and #a.b.")).toEqual([
      "#help",
      "#lounge",
      "#a.b",
    ]);
    expect(names("#start of line")).toEqual(["#start"]);
  });

  it("ignores bare numbers, a lone #, and # inside words", () => {
    expect(names("issue #3 and # and C#sharp and a#b")).toEqual([]);
  });

  it("reports where each channel starts", () => {
    expect(findChannels("see #x1 and #y2")).toEqual([
      { index: 4, name: "#x1" },
      { index: 12, name: "#y2" },
    ]);
  });
});

describe("clickable channels in messages", () => {
  const users: User[] = [{ id: "1", username: "bob", isOnline: true }];

  function renderText(text: string) {
    const onChannelClick = vi.fn();
    const out = highlightNicks(
      mircToHtml(text, "k"),
      buildNickMatcher(users, { onChannelClick, onNickClick: vi.fn() }),
    );
    render(<div>{out.node}</div>);
    return onChannelClick;
  }

  it("clicking a channel reports its name", () => {
    const onChannelClick = renderText("bob: come to #obby.");
    fireEvent.click(screen.getByRole("button", { name: "#obby" }));
    expect(onChannelClick).toHaveBeenCalledWith("#obby");
    // the nick in the same message is still a button too
    expect(screen.getByRole("button", { name: "bob" })).toBeDefined();
  });

  it("leaves channels inside links alone", () => {
    const out = highlightNicks(
      mircToHtml("https://example.com/#anchor", "k"),
      buildNickMatcher([], { onChannelClick: vi.fn() }),
    );
    expect(renderToStaticMarkup(out.node)).not.toContain("obby-channel-link");
  });

  it("does nothing without a click handler", () => {
    const out = highlightNicks(
      mircToHtml("see #obby", "k"),
      buildNickMatcher([], {}),
    );
    expect(renderToStaticMarkup(out.node)).not.toContain("<button");
  });
});
