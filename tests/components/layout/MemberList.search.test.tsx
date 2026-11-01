import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterMembers,
  MemberList,
} from "../../../src/components/layout/MemberList";
import useStore from "../../../src/store";
import type { Channel, User } from "../../../src/types";
import { defaultUIExtensions } from "../../fixtures/uiState";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const me: User = { id: "u-me", username: "me", isOnline: true };
const users: User[] = [
  me,
  { id: "u-alice", username: "Alice", isOnline: true, status: "@" },
  { id: "u-alfred", username: "alfred", isOnline: true },
  { id: "u-bob", username: "bob", isOnline: true },
];

function channel(id: string, name: string, members: User[]): Channel {
  return {
    id,
    name,
    topic: "",
    isPrivate: false,
    serverId: "server1",
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users: members,
    metadata: {},
  };
}

function selectChannel(channelId: string) {
  useStore.setState((state) => ({
    ui: {
      ...state.ui,
      perServerSelections: {
        server1: { selectedChannelId: channelId, selectedPrivateChatId: null },
      },
    },
  }));
}

describe("member list search", () => {
  beforeEach(() => {
    useStore.setState({
      servers: [
        {
          id: "server1",
          name: "Test Server",
          host: "irc.test.com",
          port: 6667,
          channels: [
            channel("channel1", "#general", users),
            channel("channel2", "#other", [me, users[3]]),
          ],
          privateChats: [],
          isConnected: true,
          users,
          connectionState: "connected",
        },
      ],
      currentUser: me,
      ui: {
        ...useStore.getState().ui,
        ...defaultUIExtensions,
        selectedServerId: "server1",
        perServerSelections: {
          server1: {
            selectedChannelId: "channel1",
            selectedPrivateChatId: null,
          },
        },
        isNarrowView: false,
        isMemberListVisible: true,
      },
    } as never);
  });

  it("matches nicks case-insensitively anywhere in the nick", () => {
    expect(filterMembers(users, "AL")?.map((u) => u.username)).toEqual([
      "Alice",
      "alfred",
    ]);
    expect(filterMembers(users, "  ")).toBe(users);
    expect(filterMembers(users, "zz")).toEqual([]);
  });

  it("narrows the list as the user types and shows the count", () => {
    render(<MemberList />);
    expect(screen.getByText("Members — 4")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "al" },
    });
    expect(screen.getByText("Members — 2 of 4")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("alfred")).toBeInTheDocument();
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
  });

  it("says when nothing matches, and the clear button restores the list", () => {
    render(<MemberList />);
    const input = screen.getByLabelText("Search members");
    fireEvent.change(input, { target: { value: "nobody" } });
    expect(screen.getByText("No members match")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(screen.queryByText("No members match")).not.toBeInTheDocument();
    expect(screen.getByText("Members — 4")).toBeInTheDocument();
  });

  it("Escape clears the search", () => {
    render(<MemberList />);
    const input = screen.getByLabelText("Search members");
    fireEvent.change(input, { target: { value: "bob" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Members — 4")).toBeInTheDocument();
  });

  it("starts from the full list again in another channel", () => {
    render(<MemberList />);
    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "al" },
    });
    act(() => selectChannel("channel2"));
    expect(screen.getByText("Members — 2")).toBeInTheDocument();
    expect(
      (screen.getByLabelText("Search members") as HTMLInputElement).value,
    ).toBe("");
  });
});
