import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageReply } from "../../src/components/message/MessageReply";
import type { Message } from "../../src/types";

afterEach(cleanup);

const reply = (overrides: Partial<Message>): Message => ({
  id: "m",
  type: "message",
  content: "hi",
  timestamp: new Date("2026-01-01T12:00:00.000Z"),
  userId: "mara",
  channelId: "c",
  serverId: "s",
  reactions: [],
  replyMessage: null,
  mentioned: [],
  ...overrides,
});

describe("MessageReply", () => {
  it("keeps the bridge marker next to a bridged author", () => {
    render(
      <MessageReply
        replyMessage={reply({ bridgedVia: "Bot" })}
        theme="discord"
        onUsernameClick={vi.fn()}
        onReplyClick={vi.fn()}
      />,
    );
    expect(screen.getByText("mara")).toBeInTheDocument();
    expect(screen.getByText("via Bot")).toBeInTheDocument();
  });

  it("shows the unwrapped name for a web user and no marker for an IRC user", () => {
    const { unmount } = render(
      <MessageReply
        replyMessage={reply({
          userId: "(Jeditwo)",
          displayNick: "Jeditwo",
          bridgedVia: "web",
        })}
        theme="discord"
        onUsernameClick={vi.fn()}
        onReplyClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Jeditwo")).toBeInTheDocument();
    expect(screen.getByText("via web")).toBeInTheDocument();
    unmount();
    render(
      <MessageReply
        replyMessage={reply({})}
        theme="discord"
        onUsernameClick={vi.fn()}
        onReplyClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^via /)).toBeNull();
  });
});
