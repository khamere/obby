import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import {
  chathistoryBuffers,
  reactionBuffers,
} from "../../src/store/handlers/batches";
import { MAX_MESSAGES_PER_CHANNEL } from "../../src/store/helpers";
import type { Message } from "../../src/types";

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), "history-server");
}
const channel = () => useStore.getState().servers[0].channels[0];
const messages = () =>
  useStore.getState().messages["history-server-channel"] ?? [];
const msg = (id: string): Message => ({
  id,
  msgid: id,
  type: "message",
  content: id,
  timestamp: new Date("2026-10-10T12:00:00Z"),
  userId: "alice",
  channelId: "channel",
  serverId: "history-server",
  reactions: [],
  replyMessage: null,
  mentioned: [],
});

describe("channel history through the IRC parser", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    ircClient.nicks.set("history-server", "me");
    chathistoryBuffers.clear();
    reactionBuffers.clear();
    useStore.setState({
      servers: [
        {
          id: "history-server",
          name: "test",
          host: "irc.test",
          port: 6697,
          isConnected: true,
          users: [],
          privateChats: [],
          capabilities: ["draft/chathistory"],
          channels: [
            {
              id: "channel",
              name: "#test",
              serverId: "history-server",
              users: [],
              messages: [],
              unreadCount: 0,
              isMentioned: false,
              isPrivate: false,
            },
          ],
        },
      ],
      messages: {},
      activeBatches: {},
      processedMessageIds: new Set(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete("history-server");
    ircClient.activeBatches.delete("history-server");
  });

  it("keeps paging through reaction-only history to reach older text", () => {
    feed(
      ":soju BATCH +events chathistory #test",
      "@batch=events;time=2026-10-10T11:00:00Z;+draft/react=ok;+draft/reply=unloaded :alice!u@h TAGMSG #test",
      ":soju BATCH -events",
    );
    expect(messages()).toHaveLength(0);
    expect(channel().hasMoreHistory).toBe(true);
    expect(channel().historyOldestTime).toBe("2026-10-10T11:00:00.000Z");
    feed(
      ":soju BATCH +older chathistory #test",
      "@batch=older;time=2026-10-10T10:00:00Z;msgid=text :alice!u@h PRIVMSG #test :older text",
      ":soju BATCH -older",
    );
    expect(messages()[0].content).toBe("older text");
    expect(channel().historyOldestTime).toBe("2026-10-10T10:00:00.000Z");
    feed(":soju BATCH +empty chathistory #test", ":soju BATCH -empty");
    expect(channel().hasMoreHistory).toBe(false);
  });

  it("does not treat already-seen channel text as an empty history page", () => {
    useStore.setState({
      messages: { "history-server-channel": [msg("cached")] },
      processedMessageIds: new Set(["cached"]),
    });
    feed(
      ":soju BATCH +repeat chathistory #test",
      "@batch=repeat;time=2026-10-10T12:00:00Z;msgid=cached :alice!u@h PRIVMSG #test :cached",
      ":soju BATCH -repeat",
    );
    expect(messages()).toHaveLength(1);
    expect(channel().hasMoreHistory).toBe(true);
  });

  it("keeps older channel text beyond the recent-message cache limit", () => {
    useStore.setState({
      messages: {
        "history-server-channel": Array.from(
          { length: MAX_MESSAGES_PER_CHANNEL },
          (_, i) => msg(`m${i}`),
        ),
      },
    });
    feed(
      ":soju BATCH +older chathistory #test",
      "@batch=older;time=2026-10-10T10:00:00Z;msgid=old :alice!u@h PRIVMSG #test :older text",
      ":soju BATCH -older",
    );
    expect(messages()).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 1);
    expect(messages()[0].msgid).toBe("old");
    feed(
      "@time=2026-10-10T13:00:00Z;msgid=live :alice!u@h PRIVMSG #test :new live message",
    );
    expect(messages()).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 2);
    expect(messages()[0].msgid).toBe("old");
  });

  it("buffers multiline channel history until the outer batch ends", () => {
    feed(
      ":soju BATCH +history chathistory #test",
      "@batch=history;time=2026-10-10T10:00:00Z;msgid=multi :alice!u@h BATCH +multi draft/multiline #test",
      "@batch=multi;time=2026-10-10T10:00:00Z;msgid=l1 :alice!u@h PRIVMSG #test :line one",
      "@batch=multi;time=2026-10-10T10:00:01Z;msgid=l2 :alice!u@h PRIVMSG #test :line two",
      ":soju BATCH -multi",
    );
    expect(messages()).toHaveLength(0);
    feed(":soju BATCH -history");
    expect(messages()[0].content).toBe("line one\nline two");
    expect(channel().hasMoreHistory).toBe(true);
    expect(channel().historyOldestTime).toBe("2026-10-10T10:00:00.000Z");
  });
});
