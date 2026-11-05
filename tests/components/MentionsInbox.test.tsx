import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionsInbox } from "../../src/components/ui/MentionsInbox";
import { muteChat, resetMutesForTests, unmuteChat } from "../../src/lib/mutes";
import useStore from "../../src/store";
import * as storage from "../../src/store/localStorage";
import type { MentionEntry } from "../../src/store/mentionLog";
import type { Server } from "../../src/types";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const mention = (
  msgid: string,
  overrides: Partial<MentionEntry> = {},
): MentionEntry => ({
  messageId: `id-${msgid}`,
  msgid,
  serverId: "s2",
  channelId: "c2",
  channelName: "#two",
  sender: "bob",
  content: `me: ${msgid}`,
  timestamp: new Date().toISOString(),
  seen: false,
  ...overrides,
});

const server = (id: string, channelIds: string[]): Server =>
  ({
    id,
    name: id === "s1" ? "One" : "Two",
    host: "irc.example",
    port: 6697,
    isConnected: true,
    users: [],
    privateChats: [],
    channels: channelIds.map((cid) => ({
      id: cid,
      name: cid === "c2" ? "#two" : "#other",
      isPrivate: false,
      serverId: id,
      unreadCount: 0,
      isMentioned: false,
      messages: [],
      users: [],
    })),
  }) as Server;

describe("MentionsInbox", () => {
  afterEach(() => {
    unmuteChat("s2", "c2");
    resetMutesForTests();
  });
  beforeEach(() => {
    resetMutesForTests();
    useStore.setState((state) => ({
      servers: [server("s1", ["c1"]), server("s2", ["c2"])],
      mentionLog: [
        mention("old", { seen: true }),
        mention("act", { content: "\u0001ACTION waves at me\u0001" }),
        mention("gone", { channelId: "c9", channelName: "#left" }),
      ],
      ui: {
        ...state.ui,
        selectedServerId: "s1",
        perServerSelections: {
          s1: { selectedChannelId: "c1", selectedPrivateChatId: null },
        },
        jumpRequest: null,
      },
    }));
  });

  it("lists mentions newest first with an unseen count", () => {
    render(<MentionsInbox />);
    expect(screen.getByLabelText("Mentions")).toHaveTextContent("2");
    fireEvent.click(screen.getByLabelText("Mentions"));
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("#left");
    expect(items[1]).toContain("* bob waves at me");
    expect(items[2]).toContain("me: old");
    expect(screen.getByText("#left · Two").closest("button")).toBeDisabled();
  });

  it("opens the channel on its server and jumps to the mention", () => {
    render(<MentionsInbox />);
    fireEvent.click(screen.getByLabelText("Mentions"));
    fireEvent.click(screen.getByText("* bob waves at me"));
    const state = useStore.getState();
    expect(state.ui.selectedServerId).toBe("s2");
    expect(state.ui.perServerSelections.s2?.selectedChannelId).toBe("c2");
    const loaded = Object.values(state.messages)
      .flat()
      .find((m) => m.msgid === "act");
    expect(state.ui.messageJump?.messageId).toBe(loaded?.id);
    expect(state.mentionLog.find((m) => m.msgid === "act")?.seen).toBe(true);
  });

  it("marks everything read", () => {
    render(<MentionsInbox />);
    fireEvent.click(screen.getByLabelText("Mentions"));
    fireEvent.click(screen.getByText("Read all mentions"));
    expect(useStore.getState().mentionLog.every((m) => m.seen)).toBe(true);
    expect(screen.getByLabelText("Mentions")).toHaveTextContent("");
  });

  it("keeps muted channels out of the badge and folds them away", () => {
    muteChat("s2", "c2", "channel", null);
    render(<MentionsInbox />);
    // The mute marked #two's mention seen; #left still counts.
    expect(screen.getByLabelText("Mentions")).toHaveTextContent("1");
    fireEvent.click(screen.getByLabelText("Mentions"));
    expect(screen.queryByText("* bob waves at me")).toBeNull();
    fireEvent.click(screen.getByText("Muted channels (2)"));
    expect(screen.getByText("* bob waves at me")).toBeInTheDocument();
    expect(
      useStore.getState().mentionLog.find((m) => m.msgid === "act")?.seen,
    ).toBe(true);
  });

  it("moves mentions back when a timed mute runs out", () => {
    vi.useFakeTimers();
    muteChat("s2", "c2", "channel", Date.now() + 60_000);
    render(<MentionsInbox />);
    fireEvent.click(screen.getByLabelText("Mentions"));
    expect(screen.getByText("Muted channels (2)")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_001);
    });
    expect(screen.queryByText(/Muted channels/)).toBeNull();
    vi.useRealTimers();
  });

  it("persists the log", () => {
    const save = vi.spyOn(storage.mentionLog, "save");
    useStore.getState().markAllMentionsSeen();
    expect(save).toHaveBeenCalledWith(useStore.getState().mentionLog);
    save.mockRestore();
  });
});
