import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageSending } from "../../src/hooks/useMessageSending";
import { base64DecodeUtf8 } from "../../src/lib/base64";
import { parseMultilineLimits } from "../../src/lib/irc/multiline";
import ircClient from "../../src/lib/ircClient";
import { parseMessageTags } from "../../src/lib/ircUtils";
import useStore from "../../src/store";
import type { Channel, PrivateChat, Server, User } from "../../src/types";

const bot = (username: string) => ({
  id: username,
  username,
  isOnline: true,
  isBot: true,
});

const channel = {
  id: "c1",
  name: "#lobby",
  users: [bot("_cloudbot"), bot("netbot")],
} as unknown as Channel;

const server = {
  id: "s1",
  name: "net",
  channels: [channel],
  privateChats: [],
  botCommands: {
    _cloudbot: [
      { name: "whois", options: [{ name: "domain", type: "string" }] },
      { name: "pkg" },
    ],
    netbot: [{ name: "pkg" }],
  },
  bots: {
    _cloudbot: { bot_id: "draft-bot-cmds:_cloudbot", scope: "channel" },
    netbot: { bot_id: "4", scope: "server" },
  },
  cmdsAvailable: ["whois"],
} as unknown as Server;

const me = { id: "me", username: "me", isOnline: true };

type Selection = Pick<
  Parameters<typeof useMessageSending>[0],
  | "selectedChannelId"
  | "selectedPrivateChatId"
  | "selectedChannel"
  | "selectedPrivateChat"
>;

const inLobby: Selection = {
  selectedChannelId: "c1",
  selectedPrivateChatId: null,
  selectedChannel: channel,
  selectedPrivateChat: null,
};

function runCommand(
  text: string,
  currentUser: User | null = null,
  selection: Selection = inLobby,
) {
  const { result } = renderHook(() =>
    useMessageSending({
      selectedServerId: "s1",
      ...selection,
      currentUser,
      selectedColor: null,
      selectedFormatting: [],
      localReplyTo: null,
    }),
  );
  result.current.sendMessage(text);
}

function sentBotCommand(sendRaw: ReturnType<typeof vi.spyOn>) {
  const line: string = sendRaw.mock.calls[0][1];
  const tag = /\+draft\/bot-cmd=(\S+)/.exec(line);
  return tag ? JSON.parse(base64DecodeUtf8(tag[1])) : null;
}

describe("slash commands shared by the server and bots", () => {
  beforeEach(() => {
    useStore.setState({ servers: [server] });
    vi.restoreAllMocks();
    vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
  });

  it("runs a bare name on the server", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/whois Valware");
    expect(sendRaw).toHaveBeenCalledWith("s1", "whois Valware");
  });

  it("sends the name to the bot it is addressed to", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/whois@_cloudbot example.com");
    expect(sentBotCommand(sendRaw)).toMatchObject({
      name: "whois",
      bot: "_cloudbot",
    });
  });

  it("sends a bare name two bots offer to the network bot", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/pkg");
    expect(sentBotCommand(sendRaw)).toMatchObject({
      name: "pkg",
      bot: "netbot",
    });
  });
});

describe("our own line on a server that echoes it", () => {
  const withCaps = (...caps: string[]) =>
    vi
      .spyOn(ircClient, "hasCapability")
      .mockImplementation((_, cap) => caps.includes(cap));
  const ownLines = () => useStore.getState().messages["s1-c1"] ?? [];

  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ servers: [server], messages: {} });
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows it as pending and marks it failed when no echo arrives", () => {
    withCaps("labeled-response", "echo-message", "batch");
    runCommand("hello", me);
    expect(ownLines()).toMatchObject([{ content: "hello", status: "pending" }]);

    vi.advanceTimersByTime(30_000);
    expect(ownLines()).toMatchObject([{ content: "hello", status: "failed" }]);
  });

  it("waits for the echo before it shows the line", () => {
    withCaps("echo-message");
    runCommand("hello", me);
    expect(ownLines()).toEqual([]);
  });
});

// A message id is the server's own text, so it can hold the characters that
// end a tag value.
describe("a reply to a message whose id needs escaping", () => {
  const msgid = "id;1 x\\y";
  const replyTags = (line: string) =>
    parseMessageTags(line.slice(0, line.indexOf(" ")));
  const expectReplyTo = (line: string) =>
    expect(replyTags(line)).toMatchObject({
      "+reply": msgid,
      "+draft/reply": msgid,
    });

  function reply(text: string, caps: string[] = []) {
    useStore.setState({
      servers: [{ ...server, capabilities: caps }],
      messages: {},
    });
    vi.spyOn(ircClient, "hasCapability").mockImplementation((_, cap) =>
      caps.includes(cap),
    );
    const lines: string[] = [];
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_, line) => {
      lines.push(line);
    });
    const { result } = renderHook(() =>
      useMessageSending({
        selectedServerId: "s1",
        ...inLobby,
        currentUser: me,
        selectedColor: null,
        selectedFormatting: [],
        localReplyTo: { msgid } as never,
      }),
    );
    result.current.sendMessage(text);
    return lines;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ servers: [server], messages: {} });
  });

  it("names it on a single line", () => {
    const lines = reply("hello");

    expect(lines).toHaveLength(1);
    expectReplyTo(lines[0]);
    expect(lines[0].endsWith(" PRIVMSG #lobby :hello")).toBe(true);
  });

  it("names it on an action", () => {
    const lines = reply("/me waves");

    expect(lines).toHaveLength(1);
    expectReplyTo(lines[0]);
    expect(lines[0].endsWith(" PRIVMSG #lobby :\u0001ACTION waves\u0001")).toBe(
      true,
    );
  });

  it("names it on the batch of a multiline message", () => {
    const lines = reply("one\ntwo", ["draft/multiline", "batch"]);

    expect(lines[0]).toMatch(/ BATCH \+\S+ draft\/multiline #lobby$/);
    expectReplyTo(lines[0]);
  });

  const withJoining = (autoFallbackToSingleLine: boolean) =>
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, autoFallbackToSingleLine },
    }));

  it("names it on each line when the server has no batches", () => {
    withJoining(false);
    const lines = reply("one\ntwo");
    withJoining(true);

    expect(lines.map((line) => line.slice(line.indexOf(" ") + 1))).toEqual([
      "PRIVMSG #lobby :one",
      "PRIVMSG #lobby :two",
    ]);
    for (const line of lines) expectReplyTo(line);
  });

  it("names it on the one line that joins the lines", () => {
    withJoining(true);
    const lines = reply("one\ntwo");

    expect(lines.map((line) => line.slice(line.indexOf(" ") + 1))).toEqual([
      "PRIVMSG #lobby :one two",
    ]);
    expectReplyTo(lines[0]);
  });
});

describe("/join", () => {
  beforeEach(() => {
    useStore.setState({ servers: [server] });
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.set(
      "s1",
      { channels: [] },
    );
  });

  afterEach(() => {
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.delete(
      "s1",
    );
    vi.restoreAllMocks();
  });

  it("sends each channel's key", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/join #secret,#open,#vault hunter2,,swordfish");
    const joins = sendRaw.mock.calls
      .map(([, line]) => line)
      .filter((line) => line.startsWith("JOIN"));
    expect(joins).toEqual([
      "JOIN #secret hunter2",
      "JOIN #open",
      "JOIN #vault swordfish",
    ]);
  });

  it.each([
    ["/join #vault hunter2", ["JOIN #vault hunter2"]],
    ["/join #vault :hunter2", ["JOIN #vault hunter2"]],
    ["/join #vault :two words", ["JOIN #vault :two words"]],
    ["/join #vault :two  words ", ["JOIN #vault :two  words"]],
    ["/join #vault :two words   ", ["JOIN #vault :two words"]],
    ["/join #vault hunter2\u00a0", ["JOIN #vault hunter2\u00a0"]],
    ["/join #vault :two words\u00a0 ", ["JOIN #vault :two words\u00a0"]],
    ["/join #vault :a\u2028b", ["JOIN #vault a\u2028b"]],
    ["/join #vault a\u2029b", ["JOIN #vault a\u2029b"]],
    ["/join #vault ::secret", ["JOIN #vault ::secret"]],
    ["/join #a,#b k1,k2", ["JOIN #a k1", "JOIN #b k2"]],
    ["/join #a,#b :k1,two words", ["JOIN #a k1", "JOIN #b :two words"]],
    ["/join #vault hunter2 extra", ["JOIN #vault hunter2"]],
    ["/join #vault", ["JOIN #vault"]],
  ])("%j sends what the same line sends as raw IRC", (text, lines) => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand(text);
    const joins = sendRaw.mock.calls
      .map(([, line]) => line)
      .filter((line) => line.startsWith("JOIN"));
    expect(joins).toEqual(lines);
  });

  it("reads the key after repeated spaces", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/join #secret   hunter2");
    expect(sendRaw).toHaveBeenCalledWith("s1", "JOIN #secret hunter2");
  });
});

describe("the /nick command", () => {
  beforeEach(() => {
    useStore.setState({ servers: [server] });
    vi.restoreAllMocks();
  });

  it("asks for the nick through the store so a confirmed change is saved", () => {
    const changeNick = vi
      .spyOn(ircClient, "changeNick")
      .mockImplementation(() => {});
    runCommand("/nick Valware2");
    expect(changeNick).toHaveBeenCalledWith("s1", "Valware2");
  });
});

describe("/topic", () => {
  beforeEach(() => {
    useStore.setState({ servers: [server] });
    vi.restoreAllMocks();
    vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
  });

  it("sends a topic with spaces as one trailing parameter", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/topic #other Welcome to  the channel");
    expect(sendRaw).toHaveBeenCalledWith(
      "s1",
      "TOPIC #other :Welcome to  the channel",
    );
  });

  it("sets the current channel's topic when no channel is named", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/topic Hello world");
    expect(sendRaw).toHaveBeenCalledWith("s1", "TOPIC #lobby :Hello world");
  });

  it("asks for the topic when none is given", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/topic #other");
    expect(sendRaw).toHaveBeenCalledWith("s1", "TOPIC #other");
  });

  it("sends the command as typed from a private chat so the server can answer", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    const mara = { id: "p1", username: "mara" } as PrivateChat;
    runCommand("/topic some text", null, {
      selectedChannelId: null,
      selectedPrivateChatId: "p1",
      selectedChannel: null,
      selectedPrivateChat: mara,
    });
    expect(sendRaw).toHaveBeenCalledWith("s1", "topic some text");
  });

  it("sends the command as typed from the server notices", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/topic", null, {
      selectedChannelId: "server-notices",
      selectedPrivateChatId: null,
      selectedChannel: null,
      selectedPrivateChat: null,
    });
    expect(sendRaw).toHaveBeenCalledWith("s1", "topic");
  });
});

describe("/rehash", () => {
  it("reaches the server", () => {
    useStore.setState({ servers: [server] });
    vi.restoreAllMocks();
    vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/rehash");
    expect(sendRaw).toHaveBeenCalledWith("s1", "rehash");
  });
});

describe("client command names in any case", () => {
  beforeEach(() => {
    useStore.setState({ servers: [server] });
    vi.restoreAllMocks();
    vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.set(
      "s1",
      { channels: [] },
    );
  });

  afterEach(() => {
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.delete(
      "s1",
    );
    vi.restoreAllMocks();
  });

  it("joins on /JOIN", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/JOIN #x,#y key");
    expect(sendRaw).toHaveBeenCalledWith("s1", "JOIN #x key");
    expect(sendRaw).toHaveBeenCalledWith("s1", "JOIN #y");
  });

  it("sends /Me as an action", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/Me waves");
    expect(sendRaw).toHaveBeenCalledWith(
      "s1",
      "PRIVMSG #lobby :\u0001ACTION waves\u0001",
    );
  });

  it("sends an unknown command to the server as typed", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    runCommand("/FOO Bar");
    expect(sendRaw).toHaveBeenCalledWith("s1", "FOO Bar");
  });
});

describe("a line longer in bytes than one message carries", () => {
  // 200 Cyrillic letters are 400 bytes, and a line to #lobby carries 377.
  const text = "д".repeat(200);
  const lineBytes = 377;
  const utf8 = new TextEncoder();
  const payload = (line: string) => line.slice(line.indexOf(" :") + 2);

  function send(message: string, caps: string[], limits?: string) {
    useStore.setState({
      servers: [{ ...server, capabilities: caps }],
      messages: {},
    });
    vi.spyOn(ircClient, "hasCapability").mockImplementation((_, cap) =>
      caps.includes(cap),
    );
    vi.spyOn(ircClient, "multilineLimits").mockReturnValue(
      parseMultilineLimits(limits),
    );
    const lines: string[] = [];
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_, line) => {
      lines.push(line);
    });
    runCommand(message, me);
    return lines;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ servers: [server], messages: {} });
  });

  it("goes out as one batch whose parts join back into the text", () => {
    const lines = send(text, ["draft/multiline", "batch"]);

    const batch = /^BATCH \+(\S+) draft\/multiline #lobby$/.exec(lines[0])?.[1];
    expect(batch).toBeTruthy();
    expect(lines.at(-1)).toBe(`BATCH -${batch}`);
    const parts = lines.slice(1, -1);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].startsWith(`@batch=${batch} PRIVMSG #lobby :`)).toBe(true);
    for (const part of parts.slice(1))
      expect(
        part.startsWith(
          `@batch=${batch};draft/multiline-concat PRIVMSG #lobby :`,
        ),
      ).toBe(true);
    for (const part of parts)
      expect(utf8.encode(payload(part)).length).toBeLessThanOrEqual(lineBytes);
    expect(parts.map(payload).join("")).toBe(text);
  });

  it("goes out as separate messages when the server's batch holds fewer bytes", () => {
    const lines = send(text, ["draft/multiline", "batch"], "max-bytes=256");

    expect(lines.some((line) => line.includes("BATCH"))).toBe(false);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith("PRIVMSG #lobby :")).toBe(true);
      expect(utf8.encode(payload(line)).length).toBeLessThanOrEqual(lineBytes);
    }
    expect(lines.map(payload).join("")).toBe(text);
  });

  it("goes out as separate messages on a server without batches", () => {
    const lines = send(text, []);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(utf8.encode(payload(line)).length).toBeLessThanOrEqual(lineBytes);
    expect(lines.map(payload).join("")).toBe(text);
  });

  it("moves a typed link that fits a line whole to its own message", () => {
    const link = `https://example.org/${"a".repeat(350)}`;

    const lines = send(`look at this one ${link}`, []);

    expect(lines).toEqual([
      "PRIVMSG #lobby :look at this one",
      `PRIVMSG #lobby :${link}`,
    ]);
  });

  it("cuts a typed link wider than a line so the server accepts every part", () => {
    const link = `https://example.org/${"a".repeat(600)}`;

    const lines = send(`look at ${link} please`, []);

    expect(lines[0]).toBe("PRIVMSG #lobby :look at");
    expect(lines.slice(1).map(payload).join("").replace(/ /g, "")).toBe(
      `${link}please`,
    );
    for (const line of lines)
      expect(utf8.encode(payload(line)).length).toBeLessThanOrEqual(lineBytes);
  });
});
