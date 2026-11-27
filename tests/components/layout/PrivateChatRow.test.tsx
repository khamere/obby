import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateChatRow } from "../../../src/components/layout/PrivateChatRow";
import { resetDraftsForTests, setDraft } from "../../../src/lib/drafts";
import useStore from "../../../src/store";
import type { PrivateChat } from "../../../src/types";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const privateChat: PrivateChat = {
  id: "pc1",
  username: "alice",
  serverId: "server1",
  unreadCount: 0,
  isPinned: true,
  isMentioned: false,
  lastActivity: new Date(),
};

const renderRow = (props: Partial<Parameters<typeof PrivateChatRow>[0]>) => {
  const onOpenMenu = vi.fn();
  const onSelect = vi.fn();
  render(
    <PrivateChatRow
      privateChat={privateChat}
      server={undefined}
      mediaSettings={{
        showSafeMedia: true,
        showTrustedSourcesMedia: true,
        showExternalContent: false,
      }}
      isSelected={false}
      isPrevious={false}
      isTouch={false}
      hoverClass=""
      onSelect={onSelect}
      onOpenMenu={onOpenMenu}
      {...props}
    />,
  );
  return { onOpenMenu, onSelect };
};

describe("PrivateChatRow", () => {
  it("opens the context menu on right click like a channel row", () => {
    const { onOpenMenu } = renderRow({});
    fireEvent.contextMenu(screen.getByText("alice"));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });

  it("shows the drag handle slot in place of the options button while reordering", () => {
    renderRow({
      isSelected: true,
      leading: <button type="button">grip</button>,
    });
    expect(screen.getByText("grip")).toBeTruthy();
    expect(screen.queryByLabelText("Open chat options")).toBeNull();
  });

  it("opens the menu from the options button when selected", () => {
    const { onOpenMenu, onSelect } = renderRow({ isSelected: true });
    fireEvent.click(screen.getByLabelText("Open chat options"));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("PrivateChatRow draft mark", () => {
  const mark = () => screen.queryByLabelText("Select to continue your draft");
  const setNarrow = (isNarrowView: boolean) =>
    useStore.setState((state) => ({ ui: { ...state.ui, isNarrowView } }));

  afterEach(() => {
    act(() => {
      resetDraftsForTests();
      setNarrow(false);
    });
  });

  it("marks a chat that holds unsent text, in any letter case", () => {
    renderRow({});
    expect(mark()).toBeNull();
    act(() => setDraft("server1", "ALICE", "hi"));
    expect(mark()).toHaveAttribute("title", "Select to continue your draft");
    act(() => setDraft("server1", "alice", ""));
    expect(mark()).toBeNull();
  });

  it("leaves the open chat unmarked while its message box is on screen", () => {
    setDraft("server1", "alice", "hi");
    renderRow({ isSelected: true });
    expect(mark()).toBeNull();
  });

  it("marks the open chat in the narrow layout, where the list hides the message box", () => {
    setDraft("server1", "alice", "hi");
    setNarrow(true);
    renderRow({ isSelected: true });
    expect(mark()).not.toBeNull();
  });

  it("leaves a chat of the same name on another server unmarked", () => {
    setDraft("server2", "alice", "hi");
    renderRow({});
    expect(mark()).toBeNull();
  });
});
