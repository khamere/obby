import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatArea } from "../../src/components/layout/ChatArea";
import useStore from "../../src/store";
import type { Channel, Message, Server } from "../../src/types";
import { defaultUIExtensions } from "../fixtures/uiState";

vi.mock("../../src/lib/ircClient", () => ({
  default: {
    sendRaw: vi.fn(),
    requestChathistoryBefore: vi.fn(() => true),
    isChannel: (_serverId: string, name?: string) =>
      !!name && "#&+!^$".includes(name[0]),
    sendTyping: vi.fn(),
    on: vi.fn(),
    getCurrentUser: vi.fn(() => ({ id: "test-user", username: "tester" })),
    getNick: vi.fn(() => "tester"),
    hasCapability: vi.fn(() => false),
    version: "1.0.0",
  },
}));

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const channel: Channel = {
  id: "channel1",
  name: "#general",
  topic: "",
  isPrivate: false,
  serverId: "server1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
};

const server: Server = {
  id: "server1",
  name: "Test Server",
  host: "irc.test.com",
  port: 6667,
  channels: [channel],
  privateChats: [],
  isConnected: true,
  users: [],
};

const makeMsg = (id: string): Message => ({
  id,
  msgid: id,
  type: "message",
  content: `Message ${id}`,
  timestamp: new Date("2024-01-01T12:00:00Z"),
  userId: "alice",
  channelId: "channel1",
  serverId: "server1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
});

const LIST_HEIGHT = 600;
const CONTENT_HEIGHT = 5000;
const BOTTOM = CONTENT_HEIGHT - LIST_HEIGHT;
const MESSAGE_COUNT = 40;
const ROW_HEIGHT = CONTENT_HEIGHT / MESSAGE_COUNT;

describe("ChatArea scroll position when a reply is cancelled", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  const runFrames = () =>
    act(() => {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame(0);
    });

  // jsdom lays nothing out, so we give the list a size and a scroll position that clamps like a browser's.
  const renderAtBottom = () => {
    const { container } = render(
      <ChatArea onToggleChanList={() => {}} isChanListVisible={true} />,
    );
    const list = container.querySelector(".obby-chat-area") as HTMLElement;
    const view = { scrollTop: BOTTOM };
    Object.defineProperty(list, "clientHeight", { value: LIST_HEIGHT });
    Object.defineProperty(list, "scrollHeight", { value: CONTENT_HEIGHT });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => view.scrollTop,
      set: (value: number) => {
        view.scrollTop = Math.min(value, BOTTOM);
      },
    });
    runFrames();
    return { list, view };
  };

  // Rows sit one under another and move with the scroll position, as a browser lays them out.
  const placeRows = (list: HTMLElement, view: { scrollTop: number }) => {
    list
      .querySelectorAll<HTMLElement>("[data-message-id]")
      .forEach((row, index) => {
        row.getBoundingClientRect = () =>
          new DOMRect(0, index * ROW_HEIGHT - view.scrollTop, 800, ROW_HEIGHT);
      });
  };

  const composer = () => screen.getByPlaceholderText(/Message #general/i);

  const startKeyboardReply = () => {
    fireEvent.keyDown(composer(), { key: "ArrowUp", ctrlKey: true });
    expect(screen.getByTitle("Cancel reply")).toBeInTheDocument();
  };

  const startReplyToNewest = () => {
    const replyButtons = screen.getAllByTitle("Reply");
    fireEvent.click(replyButtons[replyButtons.length - 1]);
    expect(screen.getByTitle("Cancel reply")).toBeInTheDocument();
  };

  const cancelReply = () => {
    fireEvent.click(screen.getByTitle("Cancel reply"));
    expect(screen.queryByTitle("Cancel reply")).toBeNull();
    runFrames();
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
      frames.set(nextFrame, frame);
      return nextFrame++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    useStore.setState({
      servers: [server],
      currentUser: { id: "user1", username: "testuser", isOnline: true },
      messages: {
        "server1-channel1": Array.from({ length: MESSAGE_COUNT }, (_, i) =>
          makeMsg(`msg-${i}`),
        ),
      },
      historyWindows: {},
      ui: {
        messageJump: null,
        selectedServerId: "server1",
        perServerSelections: {
          server1: {
            selectedChannelId: "channel1",
            selectedPrivateChatId: null,
          },
        },
        isNarrowView: false,
        isMemberListVisible: true,
        isChannelListVisible: true,
        isAddServerModalOpen: false,
        quickActions: null,
        isDarkMode: true,
        isMobileMenuOpen: false,
        linkSecurityWarnings: [],
        mobileViewActiveColumn: "serverList",
        isServerMenuOpen: false,
        contextMenu: {
          isOpen: false,
          x: 0,
          y: 0,
          type: "server",
          itemId: null,
        },
        prefillServerDetails: null,
        inputAttachments: [],
        isServerNoticesPopupOpen: false,
        serverNoticesPopupMinimized: false,
        shouldFocusChatInput: false,
        pendingBotCommandPick: null,
        pendingComposerCommand: null,
        ...defaultUIExtensions,
      },
      typingUsers: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockReset();
  });

  it("keeps the reader's place after they scrolled up during a reply started at the bottom", () => {
    const { list, view } = renderAtBottom();
    startReplyToNewest();

    view.scrollTop = 1000;
    fireEvent.scroll(list);
    cancelReply();

    expect(view.scrollTop).toBe(1000);
  });

  it("keeps the reader's place after a jump to an older message during a reply started at the bottom", () => {
    const { view } = renderAtBottom();
    startReplyToNewest();

    act(() => useStore.getState().revealMessage("msg-2"));
    expect(useStore.getState().ui.messageJump).toBeNull();
    view.scrollTop = 200;
    cancelReply();

    expect(view.scrollTop).toBe(200);
  });

  it("stays on the newest message when a reply is cancelled at the bottom", () => {
    const { list, view } = renderAtBottom();
    startReplyToNewest();

    // The reply bar gives its height back to the list, which leaves the last rows short of the end.
    view.scrollTop = BOTTOM - 20;
    fireEvent.scroll(list);
    cancelReply();

    expect(view.scrollTop).toBe(BOTTOM);
  });

  it("returns to the newest message when the reader scrolled back down before cancelling", () => {
    const { list, view } = renderAtBottom();
    startReplyToNewest();

    view.scrollTop = 1000;
    fireEvent.scroll(list);
    view.scrollTop = BOTTOM - 20;
    fireEvent.scroll(list);
    cancelReply();

    expect(view.scrollTop).toBe(BOTTOM);
  });

  it("keeps the reader's place when the reply was started while scrolled up", () => {
    const { list, view } = renderAtBottom();
    view.scrollTop = 1000;
    fireEvent.scroll(list);
    startReplyToNewest();
    cancelReply();

    expect(view.scrollTop).toBe(1000);
  });

  it.each([
    [
      "the cancel button",
      () => fireEvent.click(screen.getByTitle("Cancel reply")),
    ],
    ["Escape", () => fireEvent.keyDown(composer(), { key: "Escape" })],
  ])(
    "keeps the reader's place after they scrolled up during a reply picked with the keyboard and left with %s",
    (_name, leaveReply) => {
      const { list, view } = renderAtBottom();
      placeRows(list, view);
      startKeyboardReply();

      view.scrollTop = 1000;
      fireEvent.scroll(list);
      leaveReply();
      expect(screen.queryByTitle("Cancel reply")).toBeNull();
      runFrames();

      expect(view.scrollTop).toBe(1000);
    },
  );

  it("keeps the reader's place after a jump to an older message during a reply picked with the keyboard", () => {
    const { list, view } = renderAtBottom();
    placeRows(list, view);
    startKeyboardReply();

    act(() => useStore.getState().revealMessage("msg-2"));
    view.scrollTop = 200;
    cancelReply();

    expect(view.scrollTop).toBe(200);
  });

  it("returns to the newest message when only the keyboard navigation scrolled the list", () => {
    const { list, view } = renderAtBottom();
    placeRows(list, view);
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockImplementation(() => {
      view.scrollTop = 3000;
      fireEvent.scroll(list);
    });
    startKeyboardReply();
    expect(view.scrollTop).toBe(3000);

    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(screen.queryByTitle("Cancel reply")).toBeNull();
    runFrames();

    expect(view.scrollTop).toBe(BOTTOM);
  });
});
