import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "../../src/components/message/MessageItem";
import useStore from "../../src/store";
import type { Channel, Message, Server } from "../../src/types";

vi.mock("../../src/lib/ircClient", () => ({
  default: {
    getCurrentUser: vi.fn(() => ({
      id: "u1",
      username: "mattf",
      isOnline: true,
    })),
    getNick: vi.fn(() => "mattf"),
    hasCapability: vi.fn(() => true),
    on: vi.fn(),
    sendRaw: vi.fn(),
  },
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

const baseProps = {
  showDate: false,
  showHeader: true,
  setReplyTo: vi.fn(),
  onUsernameContextMenu: vi.fn(),
  onReactClick: vi.fn(),
  onReactionUnreact: vi.fn(),
  onOpenReactionModal: vi.fn(),
  onDirectReaction: vi.fn(),
  onRedactMessage: vi.fn(),
  serverId: "server1",
  channelId: "channel1",
};

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    msgid: "m1",
    type: "message",
    content: "some words",
    timestamp: new Date(),
    userId: "mattf",
    channelId: "channel1",
    serverId: "server1",
    reactions: [],
    replyMessage: null,
    mentioned: [],
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({ servers: [server] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a bridged line", () => {
  it("is never styled as our own message, even under our nick", () => {
    const own = render(<MessageItem message={makeMessage()} {...baseProps} />);
    expect(
      own.container.querySelector(".flex-1.min-w-0.relative")?.className,
    ).toContain("text-discord-text-strong");
    own.unmount();

    const bridged = render(
      <MessageItem
        message={makeMessage({
          bridgedVia: "Bot",
          bridgedOriginal: "[mattf] some words",
        })}
        {...baseProps}
      />,
    );
    expect(
      bridged.container.querySelector(".flex-1.min-w-0.relative")?.className,
    ).toContain("text-discord-text-normal");
    expect(
      bridged.container.querySelector("[data-bridged='true']"),
    ).not.toBeNull();
  });

  it("shows the original line on hover without IRC formatting codes", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          userId: "mara",
          bridgedVia: "WALL-E",
          bridgedOriginal: "\x0304[Chatbox]\x03 mara: some words",
        })}
        {...baseProps}
      />,
    );
    const nick = container.querySelector("span[title]");
    expect(nick?.getAttribute("title")).toBe("[Chatbox] mara: some words");
  });
});
