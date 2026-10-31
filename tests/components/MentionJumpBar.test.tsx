import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MentionJumpBar } from "../../src/components/ui/MentionJumpBar";
import useStore from "../../src/store";
import type { MentionEntry } from "../../src/store/mentionLog";

const mention = (msgid: string, seen = false): MentionEntry => ({
  messageId: `id-${msgid}`,
  msgid,
  serverId: "s1",
  channelId: "c1",
  channelName: "#test",
  sender: "bob",
  content: `me ${msgid}`,
  timestamp: "2026-10-31T10:00:00.000Z",
  seen,
});

describe("MentionJumpBar", () => {
  beforeEach(() => {
    useStore.setState((state) => ({
      mentionLog: [
        mention("a", true),
        mention("b"),
        mention("c"),
        { ...mention("x"), channelId: "c2" },
      ],
      ui: { ...state.ui, jumpRequest: null },
    }));
  });

  it("counts unseen mentions in this channel and jumps oldest first", () => {
    render(<MentionJumpBar channelKey="s1-c1" />);
    fireEvent.click(screen.getByText("2 new mentions"));
    expect(useStore.getState().ui.jumpRequest).toEqual({
      channelKey: "s1-c1",
      target: "b",
    });
    expect(screen.getByText("1 new mention")).toBeVisible();
  });

  it("dismisses every mention in the channel", () => {
    const { container } = render(<MentionJumpBar channelKey="s1-c1" />);
    fireEvent.click(screen.getByLabelText("Dismiss mentions"));
    expect(container).toBeEmptyDOMElement();
    expect(
      useStore.getState().mentionLog.find((m) => m.msgid === "x")?.seen,
    ).toBe(false);
  });

  it("renders nothing without unseen mentions", () => {
    const { container } = render(<MentionJumpBar channelKey="s1-c9" />);
    expect(container).toBeEmptyDOMElement();
  });
});
