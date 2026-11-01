import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHeader } from "../../../src/components/layout/ChatHeader";
import useStore from "../../../src/store";
import type { Channel, User } from "../../../src/types";
import { defaultUIExtensions } from "../../fixtures/uiState";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const mockCurrentUser: User = {
  id: "user1",
  username: "testuser",
  isOnline: true,
};

const mockChannel: Channel = {
  id: "channel1",
  name: "#general",
  topic: "Test topic",
  isPrivate: false,
  serverId: "server1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [mockCurrentUser],
  metadata: {},
};

describe("ChatHeader - Bots button", () => {
  beforeEach(() => {
    useStore.setState({
      servers: [
        {
          id: "server1",
          name: "Test Server",
          host: "irc.test.com",
          port: 6667,
          channels: [mockChannel],
          privateChats: [],
          isConnected: true,
          users: [mockCurrentUser],
          connectionState: "connected",
        },
      ],
      currentUser: mockCurrentUser,
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
        isMemberListVisible: false,
        isChannelListVisible: true,
        isAddServerModalOpen: false,
        quickActions: null,
        isDarkMode: true,
        isMobileMenuOpen: false,
        linkSecurityWarnings: [],
        mobileViewActiveColumn: "chatView",
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
    });

    vi.clearAllMocks();
  });

  // The overflow menu exists only on narrow screens, so a wide window
  // reaches the Bots panel through a button of its own.
  it("opens the Bots panel from the header", () => {
    const onOpenBots = vi.fn();
    render(
      <ChatHeader
        selectedChannel={mockChannel}
        selectedPrivateChat={null}
        selectedServerId="server1"
        selectedChannelId="channel1"
        currentUser={mockCurrentUser}
        isChanListVisible={true}
        isMemberListVisible={false}
        isNarrowView={false}
        globalSettings={{ notificationVolume: 0.5 }}
        onToggleChanList={() => {}}
        onToggleMemberList={() => {}}
        onToggleNotificationVolume={() => {}}
        onOpenChannelSettings={() => {}}
        onOpenInviteUser={() => {}}
        onOpenBots={onOpenBots}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage Bots" }));
    expect(onOpenBots).toHaveBeenCalledTimes(1);
  });
});
