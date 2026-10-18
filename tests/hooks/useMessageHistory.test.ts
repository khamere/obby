import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMessageHistory } from "../../src/hooks/useMessageHistory";
import type { Message } from "../../src/types";

const msg = (userId: string, content: string, id = content): Message =>
  ({
    id,
    type: "message",
    userId,
    content,
    channelId: "#test",
    serverId: "s1",
    timestamp: new Date(),
    reactions: [],
    replyMessage: null,
    mentioned: [],
  }) as unknown as Message;

const render = (
  messages: Message[] = [],
  historyKey = "s1:#test",
  currentUsername: string | null = "me",
) =>
  renderHook(
    ({ messages, historyKey }) =>
      useMessageHistory({
        messages,
        currentUsername,
        historyKey,
      }),
    { initialProps: { messages, historyKey } },
  );

describe("useMessageHistory", () => {
  it("recalls sent inputs newest first and restores the draft on the way down", () => {
    const { result } = render();
    act(() => result.current.recordSent("first"));
    act(() => result.current.recordSent("second"));

    let text: string | null = null;
    act(() => {
      text = result.current.navigateUp("draft");
    });
    expect(text).toBe("second");
    act(() => {
      text = result.current.navigateUp("second");
    });
    expect(text).toBe("first");
    // Stays at the oldest entry instead of wrapping or clearing.
    act(() => {
      text = result.current.navigateUp("first");
    });
    expect(text).toBe("first");

    act(() => {
      text = result.current.navigateDown();
    });
    expect(text).toBe("second");
    act(() => {
      text = result.current.navigateDown();
    });
    expect(text).toBe("draft");
    expect(result.current.messageHistoryIndex).toBe(-1);
  });

  it("records slash commands and skips blanks and consecutive duplicates", () => {
    const { result } = render();
    act(() => result.current.recordSent("/mode #test +m"));
    act(() => result.current.recordSent("   "));
    act(() => result.current.recordSent("/mode #test +m"));
    act(() => result.current.recordSent("hello"));
    expect(result.current.userMessageHistory).toEqual([
      "hello",
      "/mode #test +m",
    ]);
  });

  it("falls back to own channel messages and merges them behind sent inputs", () => {
    const messages = [
      msg("me", "old one"),
      msg("someone", "not mine"),
      msg("me", "\u0002bold\u0002 two"),
      msg("me", "typed"),
    ];
    const { result } = render(messages);
    expect(result.current.userMessageHistory).toEqual([
      "typed",
      "bold two",
      "old one",
    ]);

    act(() => result.current.recordSent("typed"));
    expect(result.current.userMessageHistory).toEqual([
      "typed",
      "bold two",
      "old one",
    ]);
  });

  it("keeps a separate history per conversation and leaves history mode on switch", () => {
    const { result, rerender } = render([], "s1:#a");
    act(() => result.current.recordSent("in a"));
    act(() => {
      result.current.navigateUp("");
    });
    expect(result.current.messageHistoryIndex).toBe(0);

    rerender({ messages: [], historyKey: "s1:#b" });
    expect(result.current.messageHistoryIndex).toBe(-1);
    expect(result.current.userMessageHistory).toEqual([]);
    act(() => result.current.recordSent("in b"));

    rerender({ messages: [], historyKey: "s1:#a" });
    expect(result.current.userMessageHistory).toEqual(["in a"]);
  });

  it("exitHistory drops the saved draft when the user starts typing", () => {
    const { result } = render();
    act(() => result.current.recordSent("x"));
    act(() => {
      result.current.navigateUp("draft");
    });
    act(() => result.current.exitHistory());
    expect(result.current.messageHistoryIndex).toBe(-1);
    let text: string | null = null;
    act(() => {
      text = result.current.navigateDown();
    });
    expect(text).toBeNull();
  });
});
