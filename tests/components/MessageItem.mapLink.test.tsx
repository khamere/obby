import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "../../src/components/message/MessageItem";
import useStore from "../../src/store";
import type { Channel, Message, Server } from "../../src/types";

vi.mock("../../src/lib/ircClient", () => ({
  default: {
    getCurrentUser: vi.fn(() => null),
    getNick: vi.fn(() => "tester"),
    hasCapability: vi.fn(() => false),
    on: vi.fn(),
    sendRaw: vi.fn(),
  },
}));

const mockChannel: Channel = {
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

const mockServer: Server = {
  id: "server1",
  name: "Test Server",
  host: "irc.test.com",
  port: 6667,
  channels: [mockChannel],
  privateChats: [],
  isConnected: true,
  users: [],
};

const baseProps = {
  showDate: false,
  showHeader: true,
  setReplyTo: vi.fn(),
  onUsernameContextMenu: vi.fn(),
  onReactClick: vi.fn(),
  onReactionUnreact: vi.fn(),
  onOpenReactionModal: vi.fn(),
  onDirectReaction: vi.fn(),
  serverId: "server1",
  channelId: "channel1",
};

let idCounter = 0;
function makeMessage(content: string): Message {
  idCounter++;
  return {
    id: `map${idCounter}`,
    msgid: `map${idCounter}`,
    type: "message",
    content,
    timestamp: new Date(),
    userId: "alice",
    channelId: "channel1",
    serverId: "server1",
    reactions: [],
    replyMessage: null,
    mentioned: [],
  };
}

// The host answers every request, so one probe never silences the next and
// each case sees the request it would make.
const fetchMock = vi.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
  } as unknown as Response),
);
const realIntersectionObserver = globalThis.IntersectionObserver;

// Every preview counts as on screen at once, so a probe that is going to
// happen happens during the test.
class VisibleAtOnce {
  constructor(private callback: IntersectionObserverCallback) {}
  observe() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", VisibleAtOnce);
  useStore.setState((state) => ({
    servers: [mockServer],
    globalSettings: { ...state.globalSettings, mediaVisibilityLevel: 2 },
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.stubGlobal("IntersectionObserver", realIntersectionObserver);
  vi.unstubAllGlobals();
});

describe("MessageItem — map links under trusted sources", () => {
  it("draws a card for a usable position without requesting the link", () => {
    const url =
      "https://www.openstreetmap.org/?mlat=-16.5&mlon=187.438#map=5/-16.5/187.438";
    const { container } = render(
      <MessageItem message={makeMessage(url)} {...baseProps} />,
    );

    expect(
      container.querySelector('button[aria-label="Open map"]'),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.openstreetmap.org/?mlat=91&mlon=13.4#map=14/91/13.4",
    "https://www.openstreetmap.org/?mlat=52.5&mlon=Infinity#map=14/52.5/1",
    "https://www.openstreetmap.org/?mlat=&mlon=#map=14/0/0",
  ])("keeps %s a plain link and requests nothing", async (url) => {
    const { container } = render(
      <MessageItem message={makeMessage(url)} {...baseProps} />,
    );

    expect(container.querySelector(`a[href="${url}"]`)).toBeTruthy();
    expect(container.querySelector('button[aria-label="Open map"]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // A probe starts from an effect, so we give one the time to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.openstreetmap.org/?mlat=91&mlon=7#map=14/91/7",
    "https://www.openstreetmap.org/?mlat=north&mlon=7#map=14/1/7",
  ])(
    "draws no card and requests nothing for %s inside a sentence",
    async (url) => {
      const { container } = render(
        <MessageItem
          message={makeMessage(`meet at ${url} today`)}
          {...baseProps}
        />,
      );

      expect(container.querySelector(`a[href="${url}"]`)).toBeTruthy();
      expect(
        container.querySelector('button[aria-label="Open map"]'),
      ).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // The control for the cases above: this is the request they must not make.
  it("still asks a map page that names no position what it is", async () => {
    const url = "https://www.openstreetmap.org/about";
    render(<MessageItem message={makeMessage(url)} {...baseProps} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]).toEqual([
      url,
      expect.objectContaining({ method: "HEAD" }),
    ]);
  });
});
