import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionMessage } from "../../../src/components/message/ActionMessage";
import type { MessageType } from "../../../src/types";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

// A jump (to a mention, a reply or a search hit) finds its row by the
// message id, and an action is a row like any other.
describe("ActionMessage", () => {
  it("carries the message id so a jump can find the row", () => {
    const message = {
      id: "m-slap",
      type: "message",
      content: "\u0001ACTION slaps bob around a bit with a large trout\u0001",
      timestamp: new Date("2026-11-01T10:00:00Z"),
      userId: "pinger",
      channelId: "c1",
      serverId: "s1",
      reactions: [],
      replyMessage: null,
      mentioned: ["bob"],
      tags: {},
    } as unknown as MessageType;
    const { container } = render(
      <ActionMessage
        message={message}
        showDate={false}
        onUsernameContextMenu={() => {}}
        setReplyTo={() => {}}
        onReactClick={() => {}}
        onReactionUnreact={() => {}}
        onDirectReaction={() => {}}
      />,
    );
    const row = container.querySelector('[data-message-id="m-slap"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("large trout");
  });
});
