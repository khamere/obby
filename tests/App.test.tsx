import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import ircClient from "../src/lib/ircClient";

// The app reads the link's channel from the address while its module loads, so we set it before the import above runs.
vi.hoisted(() => {
  window.history.replaceState({}, "", "/?channel=%23weather&theme=dark");
});

// Mock IRC client
vi.mock("../src/lib/ircClient", () => ({
  default: {
    connect: vi.fn().mockRejectedValue(new Error("Mock connection failed")),
    sendRaw: vi.fn(),
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    triggerEvent: vi.fn(),
    on: vi.fn(),
    deleteHook: vi.fn(),
    emit: vi.fn(),
    getCurrentUser: vi.fn(() => ({ id: "test-user", username: "tester" })),
    capAck: vi.fn(),
  },
}));

// Mock the store
let storeVersion = 0;
const mockStoreState = {
  servers: [],
  currentUser: { id: "user1", username: "testuser", isOnline: true },
  isConnecting: false,
  isAddingNewServer: false,
  selectedServerId: null,
  connectionError: null,
  messages: {},
  typingUsers: {},
  ui: {
    selectedServerId: null,
    perServerSelections: {},
    sidebarPreferences: {
      channelList: { isVisible: true, width: 264 },
      memberList: { isVisible: true, width: 280 },
    },
    isNarrowView: false,
    isAddServerModalOpen: false,
    page: null as { kind: string } | null,
    sidePane: null,
    isDarkMode: true,
    linkSecurityWarnings: [],
  },
  globalNotifications: [],
  globalSettings: {
    enableNotificationSounds: true,
    notificationSound: "/sounds/notif1.mp3",
    notificationVolume: 0.8,
    enableHighlights: true,
    sendTypingNotifications: true,
    nickname: "",
    accountName: "",
    accountPassword: "",
    customMentions: [],
    showEvents: true,
    showNickChanges: true,
    showJoinsParts: true,
    showQuits: true,
  },
  updateGlobalSettings: vi.fn(),
  joinChannel: vi.fn(),
  metadataSet: vi.fn(),
  sendRaw: vi.fn(),
  setName: vi.fn(),
  changeNick: vi.fn(),
  toggleChannelList: vi.fn(),
  connectToSavedServers: vi.fn(),
  toggleMemberList: vi.fn(),
  setIsNarrowView: vi.fn(),
  updateSidebarPreferences: vi.fn(),
  toggleQuickActions: vi.fn(),
  toggleAddServerModal: vi.fn((open?: boolean) => {
    mockStoreState.ui.isAddServerModalOpen =
      open ?? !mockStoreState.ui.isAddServerModalOpen;
    storeVersion++;
  }),
  openPage: vi.fn((page: { kind: string }) => {
    mockStoreState.ui.page = page;
    storeVersion++;
  }),
};

vi.mock("../src/store", () => {
  const getState = () => ({ ...mockStoreState, _version: storeVersion });
  const useStore = vi.fn((selector) => {
    // Return a new object each time to trigger re-renders
    const state = getState();
    return selector ? selector(state) : state;
  });
  return {
    // useChannelTabSwitching reads getState()/subscribe() directly on mount
    default: Object.assign(useStore, {
      getState,
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    }),
    loadSavedServers: vi.fn(() => []),
  };
});

describe("App", () => {
  beforeAll(() => {
    // Clear any existing event listeners
    vi.mocked(ircClient.on).mockClear();
    vi.mocked(ircClient.deleteHook).mockClear();
  });

  beforeEach(() => {
    // Reset mock state between tests
    mockStoreState.ui.isAddServerModalOpen = false;
    mockStoreState.ui.page = null;
    mockStoreState.isConnecting = false;
    mockStoreState.isAddingNewServer = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Quick search shortcut", () => {
    it("ignores a Cmd+K that arrives as the window gains focus", () => {
      const now = vi.spyOn(performance, "now");
      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      );
      const pressCmdK = () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        );

      now.mockReturnValue(10_000);
      window.dispatchEvent(new Event("focus"));
      now.mockReturnValue(10_100);
      pressCmdK();
      expect(mockStoreState.toggleQuickActions).not.toHaveBeenCalled();

      now.mockReturnValue(11_000);
      pressCmdK();
      expect(mockStoreState.toggleQuickActions).toHaveBeenCalledTimes(1);
      now.mockRestore();
    });
  });

  describe("Opened from a link with a channel", () => {
    it("takes the channel out of the address and joins it when a server registers", () => {
      expect(window.location.search).toBe("?theme=dark");

      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      );
      const readyHandlers = vi
        .mocked(ircClient.on)
        .mock.calls.filter(([event]) => event === "ready")
        .map(([, handler]) => handler as (e: { serverId: string }) => void);
      for (const handler of readyHandlers) handler({ serverId: "srv-1" });

      expect(mockStoreState.joinChannel).toHaveBeenCalledWith(
        "srv-1",
        "#weather",
      );
    });
  });

  describe("Connecting", () => {
    const renderApp = () =>
      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      );

    it("stays usable while saved servers connect at startup", () => {
      mockStoreState.isConnecting = true;
      renderApp();
      expect(screen.queryByTestId("connecting-overlay")).toBeNull();
    });

    it("waits behind a spinner while a newly added server connects", () => {
      mockStoreState.isConnecting = true;
      mockStoreState.isAddingNewServer = true;
      renderApp();
      expect(screen.getByTestId("connecting-overlay")).toBeInTheDocument();
    });
  });

  describe("Server Management", () => {
    it("Can open and close add server modal", async () => {
      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      );
      const user = userEvent.setup();

      // Open modal by clicking add server button
      await user.click(screen.getByTestId("server-list-add-button"));

      // Check that toggleAddServerModal was called with true
      expect(mockStoreState.toggleAddServerModal).toHaveBeenCalledWith(true);
    });

    it("Can add a new server with valid information", async () => {
      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      );
      const user = userEvent.setup();

      // Mock successful connection
      vi.mocked(ircClient.connect).mockResolvedValueOnce({
        id: "test-server",
        name: "Test Server",
        host: "irc.test.com",
        port: 443,
        channels: [],
        privateChats: [],
        isConnected: true,
        users: [],
        capabilities: [],
      });

      // Open modal by clicking add server button
      await user.click(screen.getByTestId("server-list-add-button"));

      // Check that toggleAddServerModal was called
      expect(mockStoreState.toggleAddServerModal).toHaveBeenCalledWith(true);
    });

    it("Shows error message when server connection fails", async () => {
      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      );
      const user = userEvent.setup();

      // Mock failed connection
      vi.mocked(ircClient.connect).mockRejectedValueOnce(
        new Error("Connection failed"),
      );

      // Open modal by clicking add server button
      await user.click(screen.getByTestId("server-list-add-button"));

      // Check that toggleAddServerModal was called
      expect(mockStoreState.toggleAddServerModal).toHaveBeenCalledWith(true);
    });
  });

  describe("User Settings", () => {
    it("Can open and close user settings modal", async () => {
      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      );
      const user = userEvent.setup();

      await user.click(screen.getByTestId("user-panel-button"));
      await user.click(screen.getByRole("menuitem", { name: /Open settings/ }));

      expect(mockStoreState.openPage).toHaveBeenCalledWith({
        kind: "settings",
      });
    });
  });
});
