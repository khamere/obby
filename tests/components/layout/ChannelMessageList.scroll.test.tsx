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
    requestChathistoryBefore: vi.fn(() => true),
    isChannel: (_serverId: string, name?: string) =>
      !!name && "#&+!^$".includes(name[0]),
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

  it("shows one date separator when the first message of a day is an action", () => {
    const today = new Date(2026, 9, 10, 11, 16);
    useStore.setState({
      messages: {
        [defaultProps.channelKey]: [
          makeMsg("yesterday", { timestamp: new Date(2026, 9, 9, 21, 38) }),
          makeMsg("action", {
            timestamp: today,
            content: "\u0001ACTION waves\u0001",
          }),
        ],
      },
    });
    render(<ChannelMessageList {...defaultProps} />);
    expect(screen.getAllByText("October 10, 2026")).toHaveLength(1);
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

  it("asks for an older page once for an empty chat, not on every render", () => {
    // No oldest message means the "page arrived" compare is on null; an
    // undefined-vs-null mismatch used to restart the request on each render.
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, keepHistory: false },
      servers: [
        makeServer({
          privateChats: [
            {
              id: "pm1",
              username: "mrkmrtns",
              serverId: "s1",
              unreadCount: 0,
              isMentioned: false,
              hasMoreHistory: true,
            },
          ],
        }),
      ],
      messages: { [defaultProps.channelKey]: [] },
    }));
    const { container } = render(<ChannelMessageList {...defaultProps} />);
    const area = container.querySelector(".obby-chat-area");
    // jsdom lays nothing out; the loader skips a container with no height.
    if (area) {
      Object.defineProperty(area, "clientHeight", { value: 600 });
      Object.defineProperty(area, "scrollHeight", { value: 300 });
    }
    for (let i = 0; i < 5; i++) {
      // A store update with the chat still empty, as any live traffic causes.
      act(() => {
        useStore.setState({ messages: { [defaultProps.channelKey]: [] } });
      });
      act(() => {
        if (area) fireEvent.scroll(area);
      });
    }
    expect(
      vi.mocked(ircClient.requestChathistoryBefore).mock.calls.length,
    ).toBeLessThanOrEqual(1);
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

describe("ChannelMessageList resized by the keyboard", () => {
  it("stays at the bottom when the list shrinks and grows back", () => {
    const observed: { callback: ResizeObserverCallback; target?: Element }[] =
      [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: { callback: ResizeObserverCallback; target?: Element };
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback };
          observed.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        disconnect() {}
      },
    );
    useStore.setState({
      messages: { [defaultProps.channelKey]: [makeMsg("m1"), makeMsg("m2")] },
      servers: [],
    });
    const { container } = render(<ChannelMessageList {...defaultProps} />);
    const list = container.firstElementChild as HTMLElement;
    let height = 600;
    let scrollTop = 400;
    Object.defineProperty(list, "clientHeight", { get: () => height });
    Object.defineProperty(list, "scrollHeight", { get: () => 1000 });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(value, 1000 - height);
      },
    });
    const resizeList = (to: number) => {
      height = to;
      for (const { callback, target } of observed)
        if (target === list) act(() => callback([], {} as ResizeObserver));
    };

    resizeList(300);
    expect(scrollTop).toBe(700);
    resizeList(600);
    expect(scrollTop).toBe(400);
    vi.unstubAllGlobals();
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

describe("ChannelMessageList jump to message", () => {
  const COUNT = DEFAULT_VISIBLE_MESSAGE_COUNT + 50;
  const many = Array.from({ length: COUNT }, (_, i) => makeMsg(`msg-${i}`));

  beforeEach(() => {
    vi.mocked(window.HTMLElement.prototype.scrollTo).mockClear();
    useStore.setState({ messages: { "s1::pm:pm1": many }, servers: [] });
    useStore.getState().clearMessageJump();
  });

  it("grows the window to reach an older message, then scrolls to it and flashes it", () => {
    const { container } = render(<ChannelMessageList {...defaultProps} />);
    expect(container.querySelector('[data-message-id="msg-5"]')).toBeNull();

    act(() => useStore.getState().revealMessage("msg-5"));

    const row = container.querySelector('[data-message-id="msg-5"]');
    expect(row).not.toBeNull();
    expect(row?.classList).toContain("jump-highlight");
    expect(window.HTMLElement.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );
    expect(useStore.getState().ui.messageJump).toBeNull();
  });

  it("keeps the jumped row when the jump mounts the list", () => {
    const setTop = vi.spyOn(Element.prototype, "scrollTop", "set");
    const height = vi
      .spyOn(Element.prototype, "scrollHeight", "get")
      .mockReturnValue(5000);
    act(() => useStore.getState().revealMessage(`msg-${COUNT - 40}`));

    const { container } = render(<ChannelMessageList {...defaultProps} />);

    expect(
      container.querySelector(`[data-message-id="msg-${COUNT - 40}"]`)
        ?.classList,
    ).toContain("jump-highlight");
    expect(setTop).not.toHaveBeenCalledWith(5000);
    setTop.mockRestore();
    height.mockRestore();
  });

  it("centres the jumped row once a hidden list is shown", () => {
    const observed: { callback: ResizeObserverCallback; target?: Element }[] =
      [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: { callback: ResizeObserverCallback; target?: Element };
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback };
          observed.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        disconnect() {}
      },
    );
    const { container } = render(<ChannelMessageList {...defaultProps} />);
    const list = container.firstElementChild as HTMLElement;
    let height = 0;
    Object.defineProperty(list, "clientHeight", { get: () => height });
    act(() => useStore.getState().revealMessage("msg-5"));
    const scrollTo = vi.mocked(window.HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();

    height = 600;
    for (const { callback, target } of observed)
      if (target === list) act(() => callback([], {} as ResizeObserver));

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
    vi.unstubAllGlobals();
  });

  it("lets go of the jumped row once the reader scrolls with the keyboard", () => {
    const { container } = render(<ChannelMessageList {...defaultProps} />);
    act(() => useStore.getState().revealMessage("msg-5"));
    const offsetTop = vi
      .spyOn(HTMLElement.prototype, "offsetTop", "get")
      .mockReturnValue(999);
    const scrollTo = vi.mocked(window.HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();

    fireEvent.keyDown(container.querySelector(".overflow-y-auto") as Element, {
      key: "End",
    });
    act(() =>
      useStore.setState({
        messages: { "s1::pm:pm1": [...many, makeMsg("new")] },
      }),
    );

    expect(scrollTo).not.toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
    offsetTop.mockRestore();
  });

  it("jumps from a reply quote to the message it answers", () => {
    const original = many[COUNT - 3];
    useStore.setState({
      messages: {
        "s1::pm:pm1": [
          ...many,
          makeMsg("reply", { replyMessage: original, content: "agreed" }),
        ],
      },
    });
    const { container } = render(<ChannelMessageList {...defaultProps} />);

    fireEvent.click(
      container.querySelector(
        '[data-message-id="reply"] [data-reply-quote]',
      ) as Element,
    );

    expect(
      container.querySelector(`[data-message-id="${original.id}"]`)?.classList,
    ).toContain("jump-highlight");
  });
});

describe("ChannelMessageList history window", () => {
  const KEY = "s1-pm1";
  const props = { ...defaultProps, channelKey: KEY };
  const present = [makeMsg("now-1"), makeMsg("now-2")];
  const past = Array.from({ length: 101 }, (_, i) =>
    makeMsg(`past-${i}`, { timestamp: new Date(Date.UTC(2023, 0, 1, 0, i)) }),
  );
  const server = (isLoadingHistory = false) => ({
    id: "s1",
    name: "TestNet",
    channels: [],
    privateChats: [
      {
        id: "pm1",
        username: "bob",
        serverId: "s1",
        unreadCount: 0,
        isMentioned: false,
        isLoadingHistory,
      },
    ],
  });
  const showPast = () =>
    act(() => {
      useStore.setState({
        messages: { [KEY]: past },
        historyWindows: {
          [KEY]: {
            until: past[100].timestamp.getTime(),
            present,
            jumpId: 1,
          },
        },
      });
      useStore.getState().revealMessage("past-50");
    });

  beforeEach(() => {
    vi.mocked(window.HTMLElement.prototype.scrollTo).mockClear();
    useStore.setState({
      messages: { [KEY]: present },
      historyWindows: {},
      globalNotifications: [],
      servers: [server()] as never,
    });
    useStore.getState().clearMessageJump();
  });

  it("flashes the message in a window that replaced the chat and offers the present", () => {
    const { container, getByRole } = render(<ChannelMessageList {...props} />);

    showPast();

    expect(
      container.querySelector('[data-message-id="past-50"]')?.classList,
    ).toContain("jump-highlight");
    fireEvent.click(getByRole("button", { name: "Scroll to bottom" }));
    expect(useStore.getState().historyWindows[KEY]).toBeUndefined();
    expect(container.querySelector('[data-message-id="now-2"]')).not.toBeNull();
  });

  it("still jumps while a history request never finished", () => {
    useStore.setState({ servers: [server(true)] as never });
    const { container } = render(<ChannelMessageList {...props} />);

    showPast();

    expect(
      container.querySelector('[data-message-id="past-50"]')?.classList,
    ).toContain("jump-highlight");
  });

  const newer = Array.from({ length: 300 }, (_, i) =>
    makeMsg(`newer-${i}`, { timestamp: new Date(Date.UTC(2023, 0, 2, 0, i)) }),
  );
  const firstRow = (container: HTMLElement) =>
    container.querySelector("[data-message-id]");

  it("keeps the rows on screen when a newer page arrives below them", () => {
    const { container } = render(<ChannelMessageList {...props} />);
    showPast();
    const top = firstRow(container);

    act(() =>
      useStore.setState((state) => ({
        messages: { [KEY]: [...past, ...newer] },
        historyWindows: {
          [KEY]: {
            ...state.historyWindows[KEY],
            until: newer[newer.length - 1].timestamp.getTime(),
          },
        },
      })),
    );

    expect(container.querySelectorAll("[data-message-id]")).toHaveLength(400);
    expect(firstRow(container)).toBe(top);
    expect(top?.isConnected).toBe(true);
  });

  it("holds the reading position when the oldest rows are dropped", () => {
    const ROW_PX = 50;
    const { container } = render(<ChannelMessageList {...props} />);
    showPast();
    const list = container.firstElementChild as HTMLElement;
    let scrollTop = 3000;
    Object.defineProperty(list, "clientHeight", { value: 600 });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const rows = [...list.querySelectorAll("[data-message-id]")];
        const index = rows.indexOf(this);
        const top = index < 0 ? 0 : index * ROW_PX - scrollTop;
        return { top, bottom: top + ROW_PX, height: ROW_PX } as DOMRect;
      });

    const rowCount = () => list.querySelectorAll("[data-message-id]").length;
    const before = rowCount();

    act(() => useStore.setState({ messages: { [KEY]: past.slice(50) } }));

    expect(scrollTop).toBe(3000 - (before - rowCount()) * ROW_PX);
    rect.mockRestore();
  });

  it("shows a toast when the message has no row to scroll to", () => {
    const join = (id: string, username: string) =>
      makeMsg(id, { type: "join", userId: username, content: "" });
    useStore.setState({
      messages: { [KEY]: [join("join-1", "carol"), join("join-2", "dave")] },
    });
    render(<ChannelMessageList {...props} />);

    act(() => useStore.getState().revealMessage("join-1"));

    expect(useStore.getState().globalNotifications.at(-1)).toMatchObject({
      command: "SEARCH_JUMP",
      code: "not-found",
    });
  });
});

describe("New messages line", () => {
  const key = defaultProps.channelKey;
  const at = (minute: number) => new Date(`2024-01-01T12:0${minute}:00.000Z`);
  const server = {
    id: "s1",
    name: "s1",
    host: "irc.example",
    port: 6697,
    isConnected: true,
    connectionState: "connected",
    capabilities: ["draft/read-marker"],
    account: "me",
    channels: [],
    users: [],
    privateChats: [
      {
        id: "pm1",
        username: "alice",
        serverId: "s1",
        unreadCount: 1,
        isMentioned: false,
        readMarker: at(0).toISOString(),
      },
    ],
  } as unknown as import("../../../src/types").Server;

  const appendWhileAway = (message: import("../../../src/types").Message) =>
    act(() => {
      useStore.setState((state) => ({
        ui: { ...state.ui, isAppFocused: false },
        messages: { [key]: [...state.messages[key], message] },
      }));
    });

  beforeEach(() => {
    useStore.setState((state) => ({
      servers: [server],
      messages: {
        [key]: [
          makeMsg("read", { timestamp: at(0) }),
          makeMsg("unread", { timestamp: at(1) }),
        ],
      },
      ui: { ...state.ui, isAppFocused: true },
    }));
  });

  it("takes no height between messages, so the messages stay put when it goes", () => {
    const { container } = render(<ChannelMessageList {...defaultProps} />);
    expect(container.querySelector("[data-unread-line]")?.className).toContain(
      "h-0",
    );
  });

  it("clears when the user sends a message, even after switching away", () => {
    const { container } = render(<ChannelMessageList {...defaultProps} />);
    expect(container.querySelector("[data-unread-line]")).not.toBeNull();

    appendWhileAway(makeMsg("mine", { userId: "tester", timestamp: at(2) }));

    expect(container.querySelector("[data-unread-line]")).toBeNull();
  });

  it("stays when the user's own join lands while they are away", () => {
    const { container } = render(<ChannelMessageList {...defaultProps} />);

    appendWhileAway(
      makeMsg("rejoin", { type: "join", userId: "tester", timestamp: at(2) }),
    );

    expect(container.querySelector("[data-unread-line]")).not.toBeNull();
  });

  it("stays while the user is away and someone else writes", () => {
    const { container } = render(<ChannelMessageList {...defaultProps} />);

    appendWhileAway(makeMsg("more", { timestamp: at(2) }));

    expect(container.querySelector("[data-unread-line]")).not.toBeNull();
  });
});
