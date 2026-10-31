import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelMessageList } from "../../../src/components/layout/ChannelMessageList";
import ircClient from "../../../src/lib/ircClient";
import useStore from "../../../src/store";
import type { Message, Server } from "../../../src/types";

vi.mock("../../../src/lib/ircClient", () => ({
  default: {
    sendRaw: vi.fn(),
    requestChathistoryBefore: vi.fn(),
    on: vi.fn(),
    getCurrentUser: vi.fn(() => ({ id: "u1", username: "tester" })),
    getNick: vi.fn(() => "tester"),
    version: "1.0.0",
  },
}));

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const KEY = "s1-c1";

const props = {
  channelKey: KEY,
  serverId: "s1",
  channelId: "c1",
  privateChatId: null as null,
  isActive: true,
  searchQuery: "",
  isMemberListVisible: false,
  onReply: vi.fn(),
  onUsernameContextMenu: vi.fn(),
  onIrcLinkClick: vi.fn(),
  onReactClick: vi.fn(),
  onReactionUnreact: vi.fn(),
  onOpenReactionModal: vi.fn(),
  onDirectReaction: vi.fn(),
  onRedactMessage: vi.fn(),
  onOpenProfile: vi.fn(),
  joinChannel: vi.fn(),
  onClearSearch: vi.fn(),
};

const msg = (n: number, overrides: Partial<Message> = {}): Message => ({
  id: `id-${n}`,
  msgid: `msgid-${n}`,
  type: "message",
  content: `line ${n}`,
  timestamp: new Date(Date.UTC(2026, 9, 31, 10, 0, n)),
  userId: n % 2 ? "alice" : "bob",
  channelId: "c1",
  serverId: "s1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
  ...overrides,
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => msg(from + i));

const server = (channel: Partial<Server["channels"][number]> = {}): Server =>
  ({
    id: "s1",
    name: "Test",
    host: "irc.example",
    port: 6697,
    isConnected: true,
    users: [],
    privateChats: [],
    capabilities: ["draft/chathistory"],
    channels: [
      {
        id: "c1",
        name: "#test",
        isPrivate: false,
        serverId: "s1",
        unreadCount: 0,
        isMentioned: false,
        messages: [],
        users: [],
        hasMoreHistory: true,
        ...channel,
      },
    ],
  }) as Server;

const rendered = (n: number) =>
  document.querySelector<HTMLElement>(`[data-message-id="id-${n}"]`);

describe("jumping to a message", () => {
  beforeEach(() => {
    vi.mocked(ircClient.requestChathistoryBefore).mockReset();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    useStore.setState((state) => ({
      servers: [server()],
      messages: { [KEY]: range(0, 150) },
      ui: { ...state.ui, jumpRequest: null },
    }));
  });

  it("renders and flashes a loaded message outside the window", () => {
    render(<ChannelMessageList {...props} />);
    expect(rendered(5)).toBeNull();

    act(() => useStore.getState().requestJumpToMessage(KEY, "msgid-5"));

    expect(rendered(5)).not.toBeNull();
    expect(rendered(5)?.classList.contains("message-flash")).toBe(true);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(useStore.getState().ui.jumpRequest).toBeNull();
    expect(ircClient.requestChathistoryBefore).not.toHaveBeenCalled();
  });

  it("pages back through history until the message arrives", () => {
    useStore.setState({ messages: { [KEY]: range(100, 150) } });
    render(<ChannelMessageList {...props} />);

    act(() => useStore.getState().requestJumpToMessage(KEY, "msgid-60"));
    expect(ircClient.requestChathistoryBefore).toHaveBeenCalledWith(
      "s1",
      "#test",
      msg(100).timestamp.toISOString(),
    );

    act(() =>
      useStore.setState({ servers: [server({ isLoadingHistory: true })] }),
    );
    act(() =>
      useStore.setState({
        servers: [server({ isLoadingHistory: false })],
        messages: { [KEY]: range(50, 150) },
      }),
    );

    expect(rendered(60)?.classList.contains("message-flash")).toBe(true);
    expect(useStore.getState().ui.jumpRequest).toBeNull();
  });

  it("gives up once the history runs out", () => {
    useStore.setState({
      servers: [server({ hasMoreHistory: false })],
      messages: { [KEY]: range(100, 150) },
    });
    render(<ChannelMessageList {...props} />);

    act(() => useStore.getState().requestJumpToMessage(KEY, "msgid-1"));

    expect(ircClient.requestChathistoryBefore).not.toHaveBeenCalled();
    expect(
      screen.getByText("Couldn't find that message in the history."),
    ).toBeVisible();
    expect(useStore.getState().ui.jumpRequest).toBeNull();
  });

  it("offers to load a reply whose original is not loaded", () => {
    useStore.setState({
      messages: {
        [KEY]: [
          ...range(100, 110),
          msg(110, { tags: { "+draft/reply": "msgid-3" } }),
        ],
      },
    });
    render(<ChannelMessageList {...props} />);

    fireEvent.click(screen.getByText("Reply to an earlier message"));

    expect(ircClient.requestChathistoryBefore).toHaveBeenCalledTimes(1);
    expect(useStore.getState().ui.jumpRequest).toEqual({
      channelKey: KEY,
      target: "msgid-3",
    });
  });
});
