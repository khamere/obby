import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "../../src/components/message/MessageItem";
import { encodeMediaDescriptor } from "../../src/lib/e2ee/media";
import { E2EE_MEDIA_TAG } from "../../src/lib/e2ee/messageFlags";
import { probeMediaUrl } from "../../src/lib/mediaProbe";
import type { MediaVisibilityLevel } from "../../src/lib/mediaUtils";
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

// The store registers its allowed-site check on the real module, so only the
// probe itself is replaced: a call to it stands for a request to that host.
vi.mock("../../src/lib/mediaProbe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/mediaProbe")>()),
  probeMediaUrl: vi.fn(async () => ({
    type: "image",
    streamable: false,
    skipped: false,
  })),
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
function makeMessage(content: string, tags?: Record<string, string>): Message {
  idCounter++;
  return {
    id: `am${idCounter}`,
    msgid: `am${idCounter}`,
    type: "message",
    content,
    timestamp: new Date(),
    userId: "alice",
    channelId: "channel1",
    serverId: "server1",
    reactions: [],
    replyMessage: null,
    mentioned: [],
    tags,
  };
}

function setMedia(level: MediaVisibilityLevel, hosts: string[]) {
  useStore.setState((state) => ({
    globalSettings: {
      ...state.globalSettings,
      mediaVisibilityLevel: level,
      mediaAllowedHosts: hosts,
    },
  }));
}

const LISTED = "https://img.example/a.png";
const OTHER = "https://other.example/b.png";
const probedUrls = () => vi.mocked(probeMediaUrl).mock.calls.map(([u]) => u);

const realObserver = global.IntersectionObserver;

beforeEach(() => {
  // Every preview counts as on screen, so a probe starts as soon as the gate
  // lets its link through.
  global.IntersectionObserver = class {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe() {
      this.cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  useStore.setState({ servers: [mockServer] });
  setMedia(1, ["img.example"]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  global.IntersectionObserver = realObserver;
});

describe("MessageItem — the user's allowed sites", () => {
  it("probes only the link on a listed site", async () => {
    const { container } = render(
      <MessageItem
        message={makeMessage(`one ${LISTED} two ${OTHER}`)}
        {...baseProps}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector(`img[src="${LISTED}"]`)).toBeTruthy(),
    );
    expect(probedUrls()).toEqual([LISTED]);
    expect(container.querySelector(`img[src="${OTHER}"]`)).toBeNull();
  });

  it("follows the list while the row stays mounted", async () => {
    const { container } = render(
      <MessageItem
        message={makeMessage(`one ${LISTED} two ${OTHER}`)}
        {...baseProps}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(`img[src="${LISTED}"]`)).toBeTruthy(),
    );

    act(() => setMedia(1, ["img.example", "other.example"]));
    await waitFor(() =>
      expect(container.querySelector(`img[src="${OTHER}"]`)).toBeTruthy(),
    );
    expect(probedUrls()).toContain(OTHER);

    act(() => setMedia(1, ["other.example"]));
    await waitFor(() =>
      expect(container.querySelector(`img[src="${LISTED}"]`)).toBeNull(),
    );
    expect(container.querySelector(`img[src="${OTHER}"]`)).toBeTruthy();
  });

  it("shows nothing from a listed site once previews are off", async () => {
    setMedia(0, ["img.example"]);
    const { container } = render(
      <MessageItem message={makeMessage(`one ${LISTED}`)} {...baseProps} />,
    );
    await act(async () => {});
    expect(probedUrls()).toEqual([]);
    expect(
      container.querySelector("img[src^='https://img.example']"),
    ).toBeNull();
  });

  it("keeps an encrypted attachment on a listed site blocked", async () => {
    const tag = encodeMediaDescriptor({
      url: "https://img.example/ab12.obb",
      k: "aaaa",
      n: "bbbb",
      mime: "image/png",
      name: "a.png",
      size: 4242,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <MessageItem
        message={makeMessage("", { [E2EE_MEDIA_TAG]: tag })}
        {...baseProps}
      />,
    );
    await act(async () => {});
    expect(container.textContent).toContain(
      "Encrypted attachment from an untrusted host.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders with settings saved before the list existed", async () => {
    useStore.setState((state) => {
      const { mediaAllowedHosts: _dropped, ...rest } = state.globalSettings;
      return { globalSettings: rest as typeof state.globalSettings };
    });
    const { container } = render(
      <MessageItem message={makeMessage(`one ${LISTED}`)} {...baseProps} />,
    );
    await act(async () => {});
    expect(container.textContent).toContain("one");
    expect(probedUrls()).toEqual([]);
  });
});
