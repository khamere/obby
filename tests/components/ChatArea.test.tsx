import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatArea } from "../../src/components/layout/ChatArea";
import {
  getDraft,
  moveDraft,
  resetDraftsForTests,
  setDraft,
} from "../../src/lib/drafts";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Channel, Server, User } from "../../src/types";
import { defaultUIExtensions } from "../fixtures/uiState";

vi.mock("../../src/lib/ircClient", () => ({
  default: {
    sendRaw: vi.fn(),
    isChannel: (_serverId: string, name?: string) =>
      !!name && "#&+!^$".includes(name[0]),
    sendTyping: vi.fn(),
    on: vi.fn(),
    getCurrentUser: vi.fn(() => ({ id: "test-user", username: "tester" })),
    getNick: vi.fn(() => "tester"),
    hasCapability: vi.fn(() => false),
    waitingLines: vi.fn(() => ({ waiting: 0, total: 0 })),
    deleteHook: vi.fn(),
    version: "1.0.0",
  },
}));

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

Object.defineProperty(HTMLInputElement.prototype, "setSelectionRange", {
  value: vi.fn(),
  writable: true,
});

const mockUsers: User[] = [
  { id: "1", username: "alice", isOnline: true },
  { id: "2", username: "bob", isOnline: true },
  { id: "3", username: "charlie", isOnline: false },
  { id: "4", username: "admin", isOnline: true },
];

const mockChannel: Channel = {
  id: "channel1",
  name: "#general",
  topic: "General discussion",
  isPrivate: false,
  serverId: "server1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: mockUsers,
};

const mockServer: Server = {
  id: "server1",
  name: "Test Server",
  host: "irc.test.com",
  port: 6667,
  channels: [mockChannel],
  privateChats: [],
  isConnected: true,
  users: mockUsers,
};

// Drafts outlive the component, so each test starts without the last one's text.
afterEach(resetDraftsForTests);

describe("ChatArea Tab Completion Integration", () => {
  beforeEach(() => {
    useStore.setState({
      servers: [mockServer],
      currentUser: { id: "user1", username: "testuser", isOnline: true },
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
        // Server notices popup state
        isServerNoticesPopupOpen: false,
        serverNoticesPopupMinimized: false,
        shouldFocusChatInput: false,
        pendingBotCommandPick: null,
        pendingComposerCommand: null,
        ...defaultUIExtensions,
      },
      messages: {},
      typingUsers: {},
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should complete nicknames with Tab key", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "al");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("alice: ");
  });

  it("should cycle through multiple matches on subsequent Tab presses", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "a");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(input).toHaveValue("admin: ");

    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(input).toHaveValue("alice: ");

    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(input).toHaveValue("admin: ");
  });

  it("should add colon when completing at message start", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "bo");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("bob: ");
  });

  it("should add space when completing in middle of message", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "hello bo");

    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("hello bob ");
  });

  it("should reset completion on other key presses", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "al");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    await userEvent.type(input, "x");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("alice: x");
  });

  it("should not complete if no matches found", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "xyz");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("xyz");
  });

  it("should send message on Enter key", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "Hello everyone!");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "server1",
      expect.stringContaining("PRIVMSG #general :Hello everyone!"),
    );

    expect(input).toHaveValue("");
  });

  it("shows the unsent draft again when the message box comes back after a kick and a rejoin", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    await userEvent.type(
      screen.getByPlaceholderText(/Message #general/i),
      "half a thought",
    );
    const setLeftReason = (leftReason?: "kicked") =>
      act(() =>
        useStore.setState({
          servers: [
            { ...mockServer, channels: [{ ...mockChannel, leftReason }] },
          ],
        }),
      );

    setLeftReason("kicked");
    expect(screen.getByTestId("rejoin-channel-bar")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Message #general/i)).toBeNull();

    setLeftReason(undefined);
    const input = screen.getByPlaceholderText(/Message #general/i);
    expect(input).toHaveValue("half a thought");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "server1",
      expect.stringContaining("PRIVMSG #general :half a thought"),
    );
  });

  it("should handle case-insensitive matching", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "BO");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("bob: ");
  });

  it("should handle empty channel users gracefully", async () => {
    const emptyChannel = { ...mockChannel, users: [] };
    const emptyServer = { ...mockServer, channels: [emptyChannel] };

    useStore.setState({
      servers: [emptyServer],
    });

    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "test");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("test");
  });

  it("should focus input after tab completion", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "bo");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveFocus();
  });

  it("should not interfere with typing when no matches found", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "xyz");

    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("xyz");
  });

  it("should not fill input with completion when Enter is pressed while dropdown is visible", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "hello bo");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("hello bob ");

    await userEvent.type(input, "how are you?");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(input).toHaveValue("");
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "server1",
      expect.stringContaining("PRIVMSG #general :hello bob how are you?"),
    );
  });

  it("should not move cursor when arrow keys are pressed with dropdown visible", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "a");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("admin: ");

    const initialCursorPosition = (input as HTMLInputElement).selectionStart;

    fireEvent.keyDown(input, { key: "ArrowDown", code: "ArrowDown" });

    expect((input as HTMLInputElement).selectionStart).toBe(
      initialCursorPosition,
    );

    fireEvent.keyDown(input, { key: "Up", code: "ArrowUp" });

    expect((input as HTMLInputElement).selectionStart).toBe(
      initialCursorPosition,
    );
  });

  it("should handle Enter key properly during tab completion", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "a");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });

    expect(input).toHaveValue("admin: ");

    // Type additional text and then send message normally
    await userEvent.type(input, "hello");

    // Clear any previous calls to sendRaw
    vi.clearAllMocks();

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // Should send the complete message
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "server1",
      expect.stringContaining("PRIVMSG #general :admin: hello"),
    );
  });

  it("opens the member list on the second Tab, where Enter takes the nick instead of sending", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "hi a");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(input).toHaveValue("hi alice ");

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(input).toHaveValue("hi alice ");
    expect(ircClient.sendRaw).not.toHaveBeenCalledWith(
      "server1",
      expect.stringContaining("PRIVMSG"),
    );

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "server1",
      expect.stringContaining("PRIVMSG #general :hi alice"),
    );
  });

  it("cycles backwards with Shift+Tab", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "a");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(input).toHaveValue("admin: ");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab", shiftKey: true });
    expect(input).toHaveValue("alice: ");
  });

  it("completes a slash command name with Tab", async () => {
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    const input = screen.getByPlaceholderText(/Message #general/i);

    await userEvent.type(input, "/joi");
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(input).toHaveValue("/join ");
  });

  it("starts a bot command from a ran chip as if it were typed", async () => {
    useStore.setState({
      servers: [
        {
          ...mockServer,
          channels: [
            {
              ...mockChannel,
              users: [
                ...mockUsers,
                { id: "5", username: "_cloudbot", isOnline: true },
              ],
            },
          ],
          botCommands: {
            _cloudbot: [
              { name: "catfact" },
              {
                name: "cakeday",
                options: [{ name: "user", type: "user", required: true }],
              },
            ],
          },
        },
      ],
    });
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    const input = screen.getByPlaceholderText(/Message #general/i);

    act(() => {
      useStore
        .getState()
        .requestComposerCommand("server1", "_cloudbot", "catfact");
    });
    expect(input).toHaveValue("/catfact@_cloudbot ");
    expect(useStore.getState().ui.pendingComposerCommand).toBeNull();

    act(() => {
      useStore
        .getState()
        .requestComposerCommand("server1", "_cloudbot", "cakeday");
    });
    expect(await screen.findByText("/cakeday")).toBeInTheDocument();
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });
});

const makeMsg = (
  id: string,
  overrides?: Partial<import("../../src/types").Message>,
): import("../../src/types").Message => ({
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
  ...overrides,
});

// channelKey = `${selectedServerId}-${selectedChannelId}` = "server1-channel1"
const NAV_CHANNEL_KEY = "server1-channel1";

describe("a command the app runs, typed in the composer", () => {
  const peer = {
    id: "pc1",
    username: "bob",
    serverId: "server1",
    unreadCount: 0,
    isMentioned: false,
    isOnline: false,
  };
  const realActions = {
    openProfile: useStore.getState().openProfile,
    addGlobalNotification: useStore.getState().addGlobalNotification,
  };

  function open(selection: {
    selectedChannelId: string | null;
    selectedPrivateChatId: string | null;
  }) {
    useStore.setState((state) => ({
      servers: [{ ...mockServer, privateChats: [peer] } as Server],
      currentUser: { id: "user1", username: "testuser", isOnline: true },
      messages: {},
      historyWindows: {},
      typingUsers: {},
      ui: {
        ...state.ui,
        ...defaultUIExtensions,
        page: null,
        isNarrowView: false,
        selectedServerId: "server1",
        perServerSelections: { server1: selection },
      },
    }));
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    return screen.getByRole("textbox") as HTMLTextAreaElement;
  }
  const inChannel = {
    selectedChannelId: "channel1",
    selectedPrivateChatId: null,
  };
  const withOfflinePeer = {
    selectedChannelId: null,
    selectedPrivateChatId: "pc1",
  };

  function send(input: HTMLElement, text: string) {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  }

  afterEach(() => {
    useStore.setState(realActions);
    vi.clearAllMocks();
  });

  it("keeps a refused command in the message box and answers in the chat", () => {
    const input = open(inChannel);

    send(input, "/query ");

    expect(input).toHaveValue("/query");
    expect(useStore.getState().messages["server1-channel1"]).toMatchObject([
      { type: "standard-reply", standardReplyType: "FAIL" },
    ]);
    expect(screen.getByText("Not run. Type it as /query <user>")).toBeTruthy();
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });

  it("runs while the peer is offline, where a message is still held back", () => {
    const openProfile = vi.fn();
    const addGlobalNotification = vi.fn();
    useStore.setState({ openProfile, addGlobalNotification });
    const input = open(withOfflinePeer);

    send(input, "/whois");

    expect(openProfile).toHaveBeenCalledWith("server1", "bob");
    expect(addGlobalNotification).not.toHaveBeenCalled();
    expect(input).toHaveValue("");

    send(input, "hello");

    expect(addGlobalNotification).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ERR_OFFLINE", target: "bob" }),
    );
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });

  it("leaves the message box when the command opens a page", () => {
    const input = open(inChannel);
    input.focus();

    send(input, "/list");

    expect(useStore.getState().ui.page).toEqual({
      kind: "channelBrowser",
      serverId: "server1",
    });
    expect(document.activeElement).not.toBe(input);
  });

  it("stays in the message box when the command answers in the chat", () => {
    const realAdd = useStore.getState().addToIgnoreList;
    const addToIgnoreList = vi.fn();
    useStore.setState({ addToIgnoreList });
    const input = open(inChannel);

    send(input, "/ignore troll");
    useStore.setState({ addToIgnoreList: realAdd });

    expect(addToIgnoreList).toHaveBeenCalledWith("troll!*@*");
    expect(document.activeElement).toBe(input);
    expect(input).toHaveValue("");
  });
});

describe("ChatArea reply keyboard navigation", () => {
  beforeEach(() => {
    useStore.setState({
      servers: [mockServer],
      currentUser: { id: "user1", username: "testuser", isOnline: true },
      messages: {
        [NAV_CHANNEL_KEY]: [makeMsg("msg-old"), makeMsg("msg-new")],
      },
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Ctrl+↑ opens reply banner for the most recent repliable message", () => {
    const { container } = render(
      <ChatArea onToggleChanList={() => {}} isChanListVisible={true} />,
    );
    const input = screen.getByPlaceholderText(/Message #general/i);

    expect(container.querySelector(".rounded-t-lg")).toBeNull();

    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });

    // Reply banner (MessageReply with onClose) has rounded-t-lg
    expect(container.querySelector(".rounded-t-lg")).not.toBeNull();
    // Input area switches to rounded-b-lg when a reply is active
    expect(container.querySelector(".rounded-b-lg")).not.toBeNull();
  });

  it("Ctrl+↑ twice navigates to the older message", () => {
    const { container } = render(
      <ChatArea onToggleChanList={() => {}} isChanListVisible={true} />,
    );
    const input = screen.getByPlaceholderText(/Message #general/i);

    // First press → newest (msg-new)
    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    const bannerAfterFirst = container.querySelector(".rounded-t-lg");
    expect(bannerAfterFirst).not.toBeNull();

    // Second press → older (msg-old) — banner stays but target changes
    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    expect(container.querySelector(".rounded-t-lg")).not.toBeNull();
  });

  it("Ctrl+↓ past the newest message cancels the reply", () => {
    const { container } = render(
      <ChatArea onToggleChanList={() => {}} isChanListVisible={true} />,
    );
    const input = screen.getByPlaceholderText(/Message #general/i);

    // Open nav
    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    expect(container.querySelector(".rounded-t-lg")).not.toBeNull();

    // Navigate back past newest
    fireEvent.keyDown(input, { key: "ArrowDown", ctrlKey: true });
    expect(container.querySelector(".rounded-t-lg")).toBeNull();
    expect(container.querySelector(".rounded-b-lg")).toBeNull();
  });

  it("Escape cancels keyboard nav and clears the reply", () => {
    const { container } = render(
      <ChatArea onToggleChanList={() => {}} isChanListVisible={true} />,
    );
    const input = screen.getByPlaceholderText(/Message #general/i);

    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    expect(container.querySelector(".rounded-t-lg")).not.toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(container.querySelector(".rounded-t-lg")).toBeNull();
  });

  it("typing a letter exits nav mode but keeps the reply banner", () => {
    const { container } = render(
      <ChatArea onToggleChanList={() => {}} isChanListVisible={true} />,
    );
    const input = screen.getByPlaceholderText(/Message #general/i);

    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    expect(container.querySelector(".rounded-t-lg")).not.toBeNull();

    // A regular key press exits nav mode (highlight removed) but localReplyTo stays
    fireEvent.keyDown(input, { key: "h" });
    expect(container.querySelector(".rounded-t-lg")).not.toBeNull();
  });

  it("ignores Ctrl+↑ when there are no repliable messages", () => {
    useStore.setState({ messages: { [NAV_CHANNEL_KEY]: [] } });

    const { container } = render(
      <ChatArea onToggleChanList={() => {}} isChanListVisible={true} />,
    );
    const input = screen.getByPlaceholderText(/Message #general/i);

    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    expect(container.querySelector(".rounded-t-lg")).toBeNull();
  });
});

describe("ChatArea drafts", () => {
  const randomChannel: Channel = {
    ...mockChannel,
    id: "channel2",
    name: "#random",
  };
  const alice = {
    id: "pm1",
    username: "alice",
    serverId: "server1",
    unreadCount: 0,
    isMentioned: false,
    isPinned: true,
  };
  const select = (selection: {
    selectedChannelId: string | null;
    selectedPrivateChatId: string | null;
  }) =>
    useStore.setState((state) => ({
      ui: {
        ...state.ui,
        ...defaultUIExtensions,
        selectedServerId: "server1",
        perServerSelections: { server1: selection },
        pendingBotCommandPick: null,
        pendingComposerCommand: null,
      },
    }));
  const selectChannel = (id: string) =>
    select({ selectedChannelId: id, selectedPrivateChatId: null });
  const setServer = (server: Partial<Server>) =>
    useStore.setState({ servers: [{ ...mockServer, ...server }] });
  const renderChat = () =>
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);

  beforeEach(() => {
    setServer({ channels: [mockChannel, randomChannel] });
    useStore.setState({
      currentUser: { id: "user1", username: "testuser", isOnline: true },
      messages: {},
      typingUsers: {},
    });
    selectChannel("channel1");
    vi.clearAllMocks();
  });

  it("records what is typed and drops it once it is sent", async () => {
    renderChat();
    const input = screen.getByPlaceholderText(/Message #general/i);
    await userEvent.type(input, "half a thought");
    expect(getDraft("server1", "#general")).toBe("half a thought");

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(getDraft("server1", "#general")).toBe("");
  });

  it("shows a chat's draft when the chat is opened, without a typing notification", () => {
    setDraft("server1", "#General", "from the last session");
    renderChat();
    expect(screen.getByPlaceholderText(/Message #general/i)).toHaveValue(
      "from the last session",
    );
    expect(ircClient.sendTyping).not.toHaveBeenCalled();
  });

  it("shows the draft of a selected chat once the server has listed it", () => {
    setDraft("server1", "#general", "from the last session");
    setServer({ channels: [] });
    renderChat();
    expect(screen.queryByPlaceholderText(/Message #general/i)).toBeNull();

    act(() => setServer({ channels: [mockChannel] }));
    expect(screen.getByPlaceholderText(/Message #general/i)).toHaveValue(
      "from the last session",
    );
  });

  it("keeps each chat's text with that chat", async () => {
    renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(/Message #general/i),
      "for general",
    );

    act(() => selectChannel("channel2"));
    expect(screen.getByPlaceholderText(/Message #random/i)).toHaveValue("");
    expect(getDraft("server1", "#general")).toBe("for general");
    expect(getDraft("server1", "#random")).toBe("");

    act(() => selectChannel("channel1"));
    expect(screen.getByPlaceholderText(/Message #general/i)).toHaveValue(
      "for general",
    );
  });

  it("records under the new nick after the person in the open chat changes nick", async () => {
    setServer({ privateChats: [alice] });
    select({ selectedChannelId: null, selectedPrivateChatId: "pm1" });
    renderChat();
    await userEvent.type(screen.getByPlaceholderText(/Message @alice/i), "hi");

    act(() => {
      moveDraft("server1", "alice", "alice_");
      setServer({ privateChats: [{ ...alice, username: "alice_" }] });
    });
    const input = screen.getByPlaceholderText(/Message @alice_/i);
    expect(input).toHaveValue("hi");

    await userEvent.type(input, "!");
    expect(getDraft("server1", "alice_")).toBe("hi!");
    expect(getDraft("server1", "alice")).toBe("");
  });

  it("keeps a command argument out of the drafts", async () => {
    renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(/Message #general/i),
      "earlier words",
    );
    act(() =>
      useStore.getState().requestBotCommandPick("server1", "authbot", {
        name: "login",
        options: [{ name: "password", required: true }],
      }),
    );
    const seen: string[] = [];
    const argument = screen.getByPlaceholderText("password");
    for (const letter of "s3cret") {
      await userEvent.type(argument, letter);
      seen.push(getDraft("server1", "#general"));
    }
    expect(argument).toHaveValue("s3cret");
    expect(seen).toEqual(Array(6).fill("earlier words"));

    act(() => selectChannel("channel2"));
    expect(screen.getByPlaceholderText(/Message #random/i)).toHaveValue("");
    expect(getDraft("server1", "#random")).toBe("");
    expect(getDraft("server1", "#general")).toBe("earlier words");
  });

  const login = {
    name: "login",
    options: [{ name: "password", required: true }],
  };

  it("keeps a command argument out of the chat opened together with a new command", async () => {
    renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(/Message #general/i),
      "earlier words",
    );
    act(() =>
      useStore.getState().requestBotCommandPick("server1", "authbot", login),
    );
    await userEvent.type(screen.getByPlaceholderText("password"), "s3cret");

    act(() => {
      selectChannel("channel2");
      useStore.getState().requestBotCommandPick("server1", "authbot", login);
    });
    expect(getDraft("server1", "#random")).toBe("");
    await userEvent.type(screen.getByPlaceholderText("password"), "x");
    expect(getDraft("server1", "#random")).toBe("");
    expect(getDraft("server1", "#general")).toBe("earlier words");
  });

  it("keeps a chat's draft when a command is started as the chat opens", () => {
    setDraft("server1", "#general", "keep me");
    useStore.getState().requestBotCommandPick("server1", "authbot", login);
    renderChat();
    expect(screen.getByPlaceholderText("password")).toHaveValue("");
    expect(getDraft("server1", "#general")).toBe("keep me");

    fireEvent.keyDown(screen.getByPlaceholderText("password"), {
      key: "Escape",
    });
    expect(screen.getByPlaceholderText(/Message #general/i)).toHaveValue(
      "keep me",
    );
  });

  it("leaves no draft behind when the open private chat is closed", async () => {
    setServer({ privateChats: [alice] });
    select({ selectedChannelId: null, selectedPrivateChatId: "pm1" });
    renderChat();
    await userEvent.type(screen.getByPlaceholderText(/Message @alice/i), "hi");
    expect(getDraft("server1", "alice")).toBe("hi");

    act(() => useStore.getState().deletePrivateChat("server1", "pm1"));
    expect(getDraft("server1", "alice")).toBe("");

    act(() => selectChannel("channel1"));
    expect(screen.getByPlaceholderText(/Message #general/i)).toHaveValue("");
    expect(getDraft("server1", "#general")).toBe("");
  });
});
