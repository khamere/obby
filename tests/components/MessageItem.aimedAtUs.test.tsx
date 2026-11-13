import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "../../src/components/message/MessageItem";
import useStore from "../../src/store";
import type { Channel, Message, Server } from "../../src/types";

const currentUser = { id: "u1", username: "mattf", isOnline: true };

vi.mock("../../src/lib/ircClient", () => ({
  default: {
    getCurrentUser: vi.fn(() => ({
      id: "u1",
      username: "mattf",
      isOnline: true,
    })),
    getNick: vi.fn(() => "mattf"),
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
function makeMessage(overrides: Partial<Message> = {}): Message {
  idCounter++;
  return {
    id: `m${idCounter}`,
    msgid: `m${idCounter}`,
    type: "message",
    content: "some words",
    timestamp: new Date(),
    userId: "alice",
    channelId: "channel1",
    serverId: "server1",
    reactions: [],
    replyMessage: null,
    mentioned: [],
    ...overrides,
  };
}

const marked = (container: HTMLElement) =>
  !!container.querySelector(".message-aimed-at-us");

beforeEach(() => {
  useStore.setState({ servers: [mockServer] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a message aimed at us", () => {
  it("leaves an ordinary message alone", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} {...baseProps} />,
    );

    expect(marked(container)).toBe(false);
  });

  it("marks a message that names us", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          content: "mattf: look at this",
          mentioned: ["mattf"],
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(true);
  });

  it("marks a reply to something we said", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          replyMessage: makeMessage({ userId: currentUser.username }),
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(true);
  });

  // Nicks compare without case, so a reply to "MattF" still reaches "mattf".
  it("marks an action replying to our nick in another case", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          content: "\u0001ACTION nods\u0001",
          replyMessage: makeMessage({ userId: "MattF" }),
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(true);
  });

  // An older line we sent before a case-only nick change is still ours.
  it("leaves our own action alone when our nick's case changed", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          userId: "MattF",
          content: "\u0001ACTION agrees\u0001",
          replyMessage: makeMessage({ userId: "MattF" }),
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(false);
  });

  it("leaves a reply to somebody else alone", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          replyMessage: makeMessage({ userId: "bob" }),
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(false);
  });

  // Our own message quoting our own nick is not someone reaching us.
  it("leaves our own message alone", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          userId: currentUser.username,
          content: "mattf: talking to myself",
          mentioned: ["mattf"],
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(false);
  });

  // "/me slaps mattf" reaches us as surely as "mattf: hi" does.
  it("marks an action that names us, and the name in it", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          content: "\u0001ACTION slaps mattf with a trout\u0001",
          mentioned: ["mattf"],
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(true);
    expect(container.querySelector(".addressed-name")?.textContent).toBe(
      "mattf",
    );
    expect(container.querySelector(".obby-mention-self")?.textContent).toBe(
      "mattf",
    );
  });

  it("leaves an action that names somebody else alone", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          content: "\u0001ACTION slaps bob with a trout\u0001",
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(false);
    expect(container.querySelector(".addressed-name")).toBeNull();
  });

  it("leaves our own action alone", () => {
    const { container } = render(
      <MessageItem
        message={makeMessage({
          userId: currentUser.username,
          content: "\u0001ACTION waves at mattf\u0001",
          mentioned: ["mattf"],
        })}
        {...baseProps}
      />,
    );

    expect(marked(container)).toBe(false);
  });
});
