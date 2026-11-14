import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageSending } from "../../src/hooks/useMessageSending";
import { base64DecodeUtf8 } from "../../src/lib/base64";
import ircClient from "../../src/lib/ircClient";
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
