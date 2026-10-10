import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelMessageList,
  type ChannelMessageListHandle,
  DEFAULT_VISIBLE_MESSAGE_COUNT,
} from "../../../src/components/layout/ChannelMessageList";
import ircClient from "../../../src/lib/ircClient";
import useStore from "../../../src/store";
import type { Server } from "../../../src/types";

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

// PM props shared by the scroll and pagination regressions.
const defaultProps = {
  channelKey: "s1::pm:pm1",
  serverId: "s1",
  channelId: null as null,
  privateChatId: "pm1",
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

const makeMsg = (
  id: string,
  overrides?: Partial<import("../../../src/types").Message>,
): import("../../../src/types").Message => ({
  id,
  msgid: id,
  type: "message",
  content: `Content of ${id}`,
  timestamp: new Date("2024-01-01T12:00:00Z"),
  userId: "alice",
  channelId: "pm1",
  serverId: "s1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
  ...overrides,
});

describe("private chat history pagination", () => {
  const makeServer = (overrides: Partial<Server> = {}): Server => ({
    id: "s1",
    name: "DKOKTO",
    host: "irc.dkok.to",
    port: 42069,
    isConnected: true,
    users: [],
    channels: [],
    privateChats: [
      {
        id: "pm1",
        username: "mrkmrtns",
        serverId: "s1",
        unreadCount: 0,
        isMentioned: false,
      },
    ],
    capabilities: ["draft/chathistory"],
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(ircClient.requestChathistoryBefore).mockReset();
    useStore.setState({
      servers: [makeServer()],
      messages: { [defaultProps.channelKey]: [makeMsg("recent")] },
    });
  });

  it("requests older messages for the PM nickname, blocks duplicate clicks and re-enables after a page", () => {
    vi.mocked(ircClient.requestChathistoryBefore).mockImplementation(() => {
      useStore.setState((state) => ({
        servers: state.servers.map((s) => ({
          ...s,
          privateChats: s.privateChats?.map((pc) => ({
            ...pc,
            isLoadingHistory: true,
          })),
        })),
      }));
    });
    render(<ChannelMessageList {...defaultProps} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Load older messages" }),
    );
    expect(ircClient.requestChathistoryBefore).toHaveBeenCalledWith(
      "s1",
      "mrkmrtns",
      "2024-01-01T12:00:00.000Z",
    );
    const loading = screen.getByRole("button", {
      name: "Getting more messages...",
    });
    expect(loading).toBeDisabled();
    fireEvent.click(loading);
    expect(ircClient.requestChathistoryBefore).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Content of recent")).toBeVisible();

    act(() =>
      useStore.setState({
        servers: [
          makeServer({
            privateChats: [
              {
                ...makeServer().privateChats?.[0],
                hasMoreHistory: true,
                isLoadingHistory: false,
              },
            ],
          }),
        ],
        messages: {
          [defaultProps.channelKey]: [
            makeMsg("older", { timestamp: new Date("2024-01-01T11:00:00Z") }),
            makeMsg("recent"),
          ],
        },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Load older messages" }),
    );
    expect(ircClient.requestChathistoryBefore).toHaveBeenLastCalledWith(
      "s1",
      "mrkmrtns",
      "2024-01-01T11:00:00.000Z",
    );
  });

  it.each([
    { capabilities: [] },
    { isConnected: false },
    { isBouncerControl: true },
    {
      privateChats: [
        {
          id: "pm1",
          username: "mrkmrtns",
          serverId: "s1",
          unreadCount: 0,
          isMentioned: false,
          hasMoreHistory: false,
        },
      ],
    },
  ])("does not offer a server request when unavailable: %j", (overrides) => {
    useStore.setState({ servers: [makeServer(overrides)] });
    render(<ChannelMessageList {...defaultProps} />);
    expect(
      screen.queryByRole("button", { name: "Load older messages" }),
    ).toBeNull();
  });

  it("reveals locally hidden messages before requesting more from Soju", () => {
    useStore.setState({
      messages: {
        [defaultProps.channelKey]: Array.from({ length: 110 }, (_, i) =>
          makeMsg(`m-${i}`),
        ),
      },
    });
    render(
      <ChannelMessageList
        {...defaultProps}
        initialScrollState={{ scrollTop: 1, visibleCount: 100 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "10 older messages" }));
    expect(screen.getByText("Content of m-0")).toBeVisible();
    expect(ircClient.requestChathistoryBefore).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Load older messages" }),
    ).toBeEnabled();
  });

  it("keeps the reading position when older PM messages are prepended", () => {
    useStore.setState({
      messages: {
        [defaultProps.channelKey]: Array.from({ length: 20 }, (_, i) =>
          makeMsg(`m-${i}`),
        ),
      },
    });
    const { container } = render(
      <ChannelMessageList
        {...defaultProps}
        initialScrollState={{ scrollTop: 80, visibleCount: 100 }}
      />,
    );
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => scroller.querySelectorAll("[data-message-id]").length * 20,
    });
    // Seed the measured height, then move away from the bottom.
    act(() =>
      useStore.setState({
        messages: {
          [defaultProps.channelKey]: [
            ...useStore.getState().messages[defaultProps.channelKey],
          ],
        },
      }),
    );
    scroller.scrollTop = 80;
    fireEvent.scroll(scroller);
    act(() =>
      useStore.setState({
        messages: {
          [defaultProps.channelKey]: [
            makeMsg("older"),
            ...useStore.getState().messages[defaultProps.channelKey],
          ],
        },
      }),
    );
    expect(scroller.scrollTop).toBe(100);
  });
});

describe("ChannelMessageList scroll state", () => {
  beforeEach(() => {
    useStore.setState({ messages: {}, servers: [] });
  });

  it("restores saved position when initialScrollState is provided", () => {
    const ref = createRef<ChannelMessageListHandle>();
    render(
      <ChannelMessageList
        {...defaultProps}
        ref={ref}
        initialScrollState={{ scrollTop: 350, visibleCount: 60 }}
      />,
    );

    const state = ref.current?.getScrollState();
    expect(state?.scrollTop).toBe(350);
    expect(state?.isAtBottom).toBe(false);
    expect(state?.visibleCount).toBe(60);
  });

  it("marks at-bottom when initialScrollState is null (user was at bottom when they left)", () => {
    const ref = createRef<ChannelMessageListHandle>();
    render(
      <ChannelMessageList
        {...defaultProps}
        ref={ref}
        initialScrollState={null}
      />,
    );

    const state = ref.current?.getScrollState();
    expect(state?.isAtBottom).toBe(true);
  });

  it("marks at-bottom and uses default window size when initialScrollState is absent (first visit)", () => {
    const ref = createRef<ChannelMessageListHandle>();
    render(<ChannelMessageList {...defaultProps} ref={ref} />);

    const state = ref.current?.getScrollState();
    expect(state?.isAtBottom).toBe(true);
    expect(state?.visibleCount).toBe(DEFAULT_VISIBLE_MESSAGE_COUNT);
  });
});

describe("ChannelMessageList highlight", () => {
  beforeEach(() => {
    useStore.setState({
      messages: {
        "s1::pm:pm1": [makeMsg("msg-a"), makeMsg("msg-b"), makeMsg("msg-c")],
      },
      servers: [],
    });
  });

  it("applies highlight class to the matching message row", () => {
    const { container } = render(
      <ChannelMessageList {...defaultProps} highlightedMessageId="msg-b" />,
    );

    const highlighted = container.querySelector('[data-message-id="msg-b"]');
    const others = [
      container.querySelector('[data-message-id="msg-a"]'),
      container.querySelector('[data-message-id="msg-c"]'),
    ];

    expect(highlighted?.className).toContain("bg-primary/10");
    expect(highlighted?.className).toContain("ring-1");
    for (const el of others) {
      expect(el?.className).not.toContain("bg-primary/10");
    }
  });

  it("applies no highlight when highlightedMessageId is undefined", () => {
    const { container } = render(
      <ChannelMessageList {...defaultProps} highlightedMessageId={undefined} />,
    );

    for (const id of ["msg-a", "msg-b", "msg-c"]) {
      const el = container.querySelector(`[data-message-id="${id}"]`);
      expect(el?.className).not.toContain("bg-primary/10");
    }
  });
});
