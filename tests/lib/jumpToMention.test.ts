import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { jumpToMention } from "../../src/lib/jumpToMention";
import useStore from "../../src/store";
import type { MentionEntry } from "../../src/store/mentionLog";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: vi.fn(() => false),
}));

// A mention whose message is no longer loaded, on a bouncer that saves
// nothing locally (no msgids): the server is asked for the page around it.
const SERVER = "jump-srv";
const CHANNEL = "chan-a";
const KEY = `${SERVER}-${CHANNEL}`;
const TIME = "2026-11-01T10:00:00.000Z";

function connect() {
  const sent: string[] = [];
  (ircClient as unknown as { sockets: Map<string, unknown> }).sockets.set(
    SERVER,
    {
      readyState: WebSocket.OPEN,
      send: (raw: string) => sent.push(raw),
      close: () => {},
    },
  );
  const server = {
    id: SERVER,
    name: SERVER,
    host: "irc.test",
    port: 6697,
    isConnected: true,
    capabilities: ["draft/chathistory", "batch", "server-time"],
    channels: [
      {
        id: CHANNEL,
        name: "#a",
        isPrivate: false,
        serverId: SERVER,
        unreadCount: 0,
        isMentioned: false,
        messages: [],
        users: [],
        readMarker: null,
      },
    ],
    privateChats: [],
    users: [],
  };
  ircClient.servers.set(SERVER, { ...server, channels: [] } as never);
  ircClient.nicks.set(SERVER, "bob");
  useStore.setState({
    servers: [server] as never,
    messages: { [KEY]: [] },
    activeBatches: {},
    processedMessageIds: new Set(),
    ui: {
      ...useStore.getState().ui,
      selectedServerId: SERVER,
      perServerSelections: {
        [SERVER]: { selectedChannelId: CHANNEL, selectedPrivateChatId: null },
      },
    },
  });
  return sent;
}
const feed = (...lines: string[]) =>
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), SERVER);

const entry: MentionEntry = {
  messageId: "gone-id",
  serverId: SERVER,
  channelId: CHANNEL,
  channelName: "#a",
  sender: "pinger",
  content: "bob: are you there?",
  timestamp: TIME,
  seen: false,
};

describe("jumpToMention", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.disconnect(SERVER);
    ircClient.servers.delete(SERVER);
    ircClient.nicks.delete(SERVER);
  });

  it("asks the server around the mention and reveals the message once it lands", async () => {
    const sent = connect();
    const jump = jumpToMention(entry);
    await vi.waitFor(() =>
      expect(
        sent.find((l) => l.startsWith("CHATHISTORY AROUND #a timestamp=")),
      ).toBeDefined(),
    );
    feed(
      ":soju BATCH +h chathistory #a",
      `@batch=h;time=${TIME} :pinger!u@h PRIVMSG #a :bob: are you there?`,
      ":soju BATCH -h",
    );
    await jump;
    const shown = useStore.getState().messages[KEY];
    expect(shown.map((m) => m.content)).toContain("bob: are you there?");
    expect(useStore.getState().ui.messageJump?.messageId).toBe(
      shown.find((m) => m.content === "bob: are you there?")?.id,
    );
  });

  it("reveals a loaded message without asking the server", async () => {
    const sent = connect();
    useStore.getState().addMessage({
      id: "gone-id",
      type: "message",
      content: "bob: are you there?",
      timestamp: new Date(TIME),
      userId: "pinger",
      channelId: CHANNEL,
      serverId: SERVER,
      reactions: [],
      replyMessage: null,
      mentioned: ["bob"],
    });
    await jumpToMention(entry);
    expect(useStore.getState().ui.messageJump?.messageId).toBe("gone-id");
    expect(sent.filter((l) => l.startsWith("CHATHISTORY"))).toEqual([]);
  });
});
