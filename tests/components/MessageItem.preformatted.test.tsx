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

const art = '  .4HH      .4HH\n   HH        HH\n,pP"Yb.  .gP"Ya';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    msgid: "m1",
    type: "message",
    content: art,
    timestamp: new Date(),
    userId: "irc.test.com",
    channelId: "channel1",
    serverId: "server1",
    reactions: [],
    replyMessage: null,
    mentioned: [],
    preformatted: true,
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({ servers: [server] });
});
afterEach(cleanup);

describe("MessageItem preformatted server text", () => {
  it("keeps lines whole on narrow screens and wraps only from the small breakpoint up", () => {
    const { container } = render(
      <MessageItem {...baseProps} message={makeMessage()} />,
    );
    const block = container.querySelector(".font-mono") as HTMLElement;
    expect(block).not.toBeNull();
    const classes = block.className.split(/\s+/);
    expect(classes).toContain("whitespace-pre");
    expect(classes).toContain("overflow-x-auto");
    expect(classes).toContain("sm:whitespace-pre-wrap");
    expect(classes).not.toContain("whitespace-pre-wrap");
    expect(block.textContent).toBe(art);
  });
});
