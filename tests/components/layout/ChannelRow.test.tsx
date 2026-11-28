import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRow } from "../../../src/components/layout/ChannelRow";
import { resetDraftsForTests, setDraft } from "../../../src/lib/drafts";
import useStore from "../../../src/store";
import type { Channel } from "../../../src/types";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const channel = {
  id: "c1",
  name: "#general",
  serverId: "server1",
  isPrivate: false,
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
} as Channel;

const renderRow = (
  props: Partial<Parameters<typeof ChannelRow>[0]> = {},
  serverId = "server1",
) =>
  render(
    <ChannelRow
      channel={channel}
      serverId={serverId}
      isSelected={false}
      isPrevious={false}
      isInCall={false}
      isTouch={false}
      hoverClass=""
      onSelect={() => {}}
      onOpenMenu={() => {}}
      {...props}
    />,
  );

describe("ChannelRow draft mark", () => {
  const mark = () => screen.queryByLabelText("Select to continue your draft");
  const setNarrow = (isNarrowView: boolean) =>
    useStore.setState((state) => ({ ui: { ...state.ui, isNarrowView } }));

  afterEach(() => {
    act(() => {
      resetDraftsForTests();
      setNarrow(false);
    });
  });

  it("marks a channel that holds unsent text, in any letter case", () => {
    renderRow();
    expect(mark()).toBeNull();
    act(() => setDraft("server1", "#GENERAL", "half a thought"));
    expect(mark()).toHaveAttribute("title", "Select to continue your draft");
    act(() => setDraft("server1", "#general", ""));
    expect(mark()).toBeNull();
  });

  it("leaves the open channel unmarked while its message box is on screen", () => {
    setDraft("server1", "#general", "half a thought");
    renderRow({ isSelected: true });
    expect(mark()).toBeNull();
  });

  it("marks the open channel in the narrow layout, where the list hides the message box", () => {
    setDraft("server1", "#general", "half a thought");
    setNarrow(true);
    renderRow({ isSelected: true });
    expect(mark()).not.toBeNull();
  });

  it("leaves a channel of the same name on another server unmarked", () => {
    setDraft("server1", "#general", "half a thought");
    renderRow({}, "server2");
    expect(mark()).toBeNull();
  });

  it.each([
    ["we are not in", { leftReason: "kicked" }],
    ["needs a key", { needsKey: true }],
  ] as const)(
    "leaves a channel that %s unmarked, since it has no message box",
    (_case, state) => {
      setDraft("server1", "#general", "half a thought");
      renderRow({ channel: { ...channel, ...state } as Channel });
      expect(mark()).toBeNull();
    },
  );
});
