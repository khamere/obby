import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageSending } from "../../src/hooks/useMessageSending";
import { base64DecodeUtf8 } from "../../src/lib/base64";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type {
  Channel,
  Message,
  PrivateChat,
  Server,
  User,
} from "../../src/types";

const helpBot = { id: "h", username: "HelpBot", isOnline: true, isBot: true };
const lounge = {
  id: "c1",
  name: "#lounge",
  users: [helpBot],
} as unknown as Channel;
const bob = { id: "pc-bob", username: "bob", serverId: "s1" } as PrivateChat;
const carol = {
  id: "pc-carol",
  username: "carol",
  serverId: "s1",
  isPinned: true,
} as PrivateChat;
const server = {
  id: "s1",
  name: "net",
  channels: [lounge],
  privateChats: [bob, carol],
} as unknown as Server;
const me = { id: "me", username: "me", isOnline: true } as User;

type Place = Pick<
  Parameters<typeof useMessageSending>[0],
  | "selectedChannelId"
  | "selectedPrivateChatId"
  | "selectedChannel"
  | "selectedPrivateChat"
>;
const inLounge: Place = {
  selectedChannelId: "c1",
  selectedPrivateChatId: null,
  selectedChannel: lounge,
  selectedPrivateChat: null,
};
const withPeer = (chat: PrivateChat): Place => ({
  selectedChannelId: null,
  selectedPrivateChatId: chat.id,
  selectedChannel: null,
  selectedPrivateChat: chat,
});
const inServerNotices: Place = {
  selectedChannelId: "server-notices",
  selectedPrivateChatId: null,
  selectedChannel: null,
  selectedPrivateChat: null,
};

function run(text: string, place: Place = inLounge) {
  const { result } = renderHook(() =>
    useMessageSending({
      selectedServerId: "s1",
      ...place,
      currentUser: me,
      selectedColor: null,
      selectedFormatting: [],
      localReplyTo: null,
    }),
  );
  return result.current.sendMessage(text);
}

const actions = {
  openChat: vi.fn(),
  openProfile: vi.fn(),
  openPage: vi.fn(),
  addToIgnoreList: vi.fn(),
  removeFromIgnoreList: vi.fn(),
  leaveChannel: vi.fn(),
  deletePrivateChat: vi.fn(),
  setMobileViewActiveColumn: vi.fn(),
  clearChatView: vi.fn(),
};
const original = useStore.getState();
const realActions = Object.fromEntries(
  Object.keys(actions).map((name) => [name, original[name as never]]),
);

const rows = (chatId = "c1") =>
  (useStore.getState().messages[`s1-${chatId}`] ?? []).map((m) => ({
    type: m.standardReplyType,
    command: m.standardReplyCommand,
    code: m.standardReplyCode,
    text: m.standardReplyMessage,
  }));
const setIgnoreList = (ignoreList: string[]) =>
  useStore.setState((state) => ({
    globalSettings: { ...state.globalSettings, ignoreList },
  }));
const setNarrow = (isNarrowView: boolean) =>
  useStore.setState((state) => ({ ui: { ...state.ui, isNarrowView } }));

let sendRaw: ReturnType<typeof vi.spyOn>;
let isSocketOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    servers: [server],
    messages: {},
    historyWindows: {},
    ...actions,
  } as never);
  setIgnoreList(["HistServ!*@*"]);
  setNarrow(false);
  vi.spyOn(ircClient, "getNick").mockReturnValue("me");
  isSocketOpen = vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
  sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  useStore.setState(realActions as never);
});

function expectRefused(text: string, code: string, place: Place = inLounge) {
  const chatId = place.selectedChannelId ?? place.selectedPrivateChatId ?? "";
  expect(run(text, place)).toBe("withheld");
  expect(rows(chatId)).toMatchObject([{ type: "FAIL", code }]);
}

describe("/query", () => {
  it("opens the private chat as the list's own row does", () => {
    expect(run("/query alice")).toBeUndefined();
    expect(actions.openChat).toHaveBeenCalledWith("s1", "alice");
    expect(rows()).toEqual([]);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it.each(["/query", "/query alice hello", "/query #lounge", "/query a,b"])(
    "answers %j with how to type it",
    (text) => {
      expectRefused(text, "USAGE");
      expect(rows()[0]).toMatchObject({
        command: "QUERY",
        text: "Not run. Type it as /query <user>",
      });
      expect(actions.openChat).not.toHaveBeenCalled();
    },
  );

  it("refuses our own nick in any case", () => {
    expectRefused("/query ME", "OWN_NICK");
    expect(rows()[0].text).toBe("Not run. ME matches your own nick");
    expect(actions.openChat).not.toHaveBeenCalled();
  });
});

describe("/whois", () => {
  it.each([
    ["/whois alice", inLounge, "alice"],
    ["/whois", inLounge, "me"],
    ["/whois", withPeer(bob), "bob"],
    ["/whois x alice", inLounge, "alice"],
  ])("%j opens the profile", (text, place, nick) => {
    expect(run(text, place)).toBeUndefined();
    expect(actions.openProfile).toHaveBeenCalledWith("s1", nick);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it.each(["/whois a b c", "/whois #lounge"])(
    "answers %j with how to type it",
    (text) => {
      expectRefused(text, "USAGE");
      expect(actions.openProfile).not.toHaveBeenCalled();
    },
  );
});

describe("/ignore", () => {
  it("adds the nick as the menu does and names the entry", () => {
    expect(run("/ignore troll")).toBeUndefined();
    expect(actions.addToIgnoreList).toHaveBeenCalledWith("troll!*@*");
    expect(rows()).toEqual([
      {
        type: "NOTE",
        command: "IGNORE",
        code: "IGNORED",
        text: "Ignoring troll!*@*",
      },
    ]);
  });

  it("names the entry we already hold in another case and adds none", () => {
    setIgnoreList(["Troll!*@*"]);
    run("/ignore troll");
    expect(actions.addToIgnoreList).not.toHaveBeenCalled();
    expect(rows()).toMatchObject([
      { code: "IGNORED", text: "Ignoring Troll!*@*" },
    ]);
  });

  it.each(["/ignore me", "/ignore *", "/ignore m*"])(
    "refuses %j, which would hide our own lines",
    (text) => {
      expectRefused(text, "OWN_NICK");
      expect(actions.addToIgnoreList).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/ignore a b",
    "/ignore #lounge",
    "/ignore *!*@bad.example",
    "/ignore user@host",
    "/ignore troll\nmore",
  ])("answers %j with how to type it", (text) => {
    expectRefused(text, "USAGE");
    expect(rows()[0].text).toBe("Not run. Type it as /ignore [user]");
    expect(actions.addToIgnoreList).not.toHaveBeenCalled();
  });

  it.each(["/ignore", "/unignore"])(
    "%j alone opens the ignore list setting",
    (text) => {
      expect(run(text)).toBeUndefined();
      expect(actions.openPage).toHaveBeenCalledWith({
        kind: "settings",
        section: "preferences",
        highlight: "preferences.ignoreList",
        fromSearch: true,
      });
      expect(rows()).toEqual([]);
    },
  );
});

describe("/unignore", () => {
  beforeEach(() => setIgnoreList(["HistServ!*@*", "troll!*@*", "tr*!*@*"]));

  it("removes every entry that hides the nick and names them", () => {
    expect(run("/unignore troll")).toBeUndefined();
    expect(actions.removeFromIgnoreList.mock.calls).toEqual([
      ["troll!*@*"],
      ["tr*!*@*"],
    ]);
    expect(rows()).toEqual([
      {
        type: "NOTE",
        command: "UNIGNORE",
        code: "UNIGNORED",
        text: "No longer ignoring troll!*@*, tr*!*@*",
      },
    ]);
  });

  it("says so when nothing matches", () => {
    expectRefused("/unignore nobody", "NO_MATCH");
    expect(rows()[0].text).toBe(
      "Nothing on the ignore list matches nobody. Type /ignore to see the list",
    );
    expect(actions.removeFromIgnoreList).not.toHaveBeenCalled();
  });
});

describe("/close", () => {
  it("leaves the channel as the menu does", () => {
    expect(run("/close")).toBeUndefined();
    expect(actions.leaveChannel).toHaveBeenCalledWith("s1", "#lounge");
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("closes the conversation", () => {
    expect(run("/close", withPeer(bob))).toBeUndefined();
    expect(actions.deletePrivateChat).toHaveBeenCalledWith("s1", "pc-bob");
    expect(actions.setMobileViewActiveColumn).not.toHaveBeenCalled();
  });

  it("returns to the chat list on a narrow screen", () => {
    setNarrow(true);
    run("/close", withPeer(bob));
    expect(actions.deletePrivateChat).toHaveBeenCalledWith("s1", "pc-bob");
    expect(actions.setMobileViewActiveColumn).toHaveBeenCalledWith(
      "serverList",
    );
  });

  it("keeps a pinned conversation and says why", () => {
    expectRefused("/close", "PINNED", withPeer(carol));
    expect(rows("pc-carol")[0].text).toBe(
      "Not closed. Unpin this conversation first",
    );
    expect(actions.deletePrivateChat).not.toHaveBeenCalled();
  });

  it("closes nothing when a target is named", () => {
    expectRefused("/close #other", "USAGE");
    expect(actions.leaveChannel).not.toHaveBeenCalled();
  });

  it("has nothing to close in the server notices", () => {
    expectRefused("/close", "USAGE", inServerNotices);
  });
});

describe("/clear", () => {
  it.each(["/clear", "/clear\n"])("%j clears this chat's view", (text) => {
    expect(run(text)).toBeUndefined();
    expect(actions.clearChatView).toHaveBeenCalledWith("s1", "c1");
    expect(rows()).toEqual([]);
  });

  it("clears nothing when an argument follows", () => {
    expectRefused("/clear all", "USAGE");
    expect(actions.clearChatView).not.toHaveBeenCalled();
  });
});

describe("/list", () => {
  it("opens the channel browser", () => {
    expect(run("/list")).toBeUndefined();
    expect(actions.openPage).toHaveBeenCalledWith({
      kind: "channelBrowser",
      serverId: "s1",
    });
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("takes no search words", () => {
    expectRefused("/list *x*", "USAGE");
    expect(actions.openPage).not.toHaveBeenCalled();
  });
});

describe("/raw", () => {
  it("sends the line as typed and never repeats it in the chat", () => {
    expect(run("/raw PRIVMSG #a :two  spaces")).toBeUndefined();
    expect(sendRaw.mock.calls).toEqual([["s1", "PRIVMSG #a :two  spaces"]]);
    expect(rows()).toMatchObject([
      { type: "NOTE", command: "RAW", code: "SENT" },
    ]);
    expect(rows()[0].text).not.toContain("PRIVMSG");
  });

  it("reads the name in any case", () => {
    run("/RAW version");
    expect(sendRaw.mock.calls).toEqual([["s1", "version"]]);
  });

  it.each(["/raw", "/raw   "])("answers %j with how to type it", (text) => {
    expectRefused(text, "USAGE");
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it.each(["/raw PRIVMSG #a :x\nQUIT", "/raw\nQUIT", "/raw a\rb"])(
    "refuses %j, which holds a second line",
    (text) => {
      expectRefused(text, "ONE_LINE");
      expect(sendRaw).not.toHaveBeenCalled();
    },
  );

  it("says so when the connection is down", () => {
    isSocketOpen.mockReturnValue(false);
    expectRefused("/raw TIME", "NOT_CONNECTED");
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

describe("a command typed while reading older history", () => {
  it("returns to the present, where its answer is the last row", () => {
    const old = { id: "m1", content: "old", timestamp: new Date(1000) };
    const m9 = { id: "m9", content: "new", timestamp: new Date(9000) };
    useStore.setState({
      messages: { "s1-c1": [old as Message] },
      historyWindows: { "s1-c1": { until: 5000, present: [m9 as Message] } },
    });

    expect(run("/query")).toBe("withheld");

    const state = useStore.getState();
    expect(state.historyWindows["s1-c1"]).toBeUndefined();
    expect(state.messages["s1-c1"].map((m) => m.id ?? m.type)).toEqual([
      "m9",
      expect.any(String),
    ]);
    expect(state.messages["s1-c1"][1]).toMatchObject({
      type: "standard-reply",
      standardReplyType: "FAIL",
      standardReplyCode: "USAGE",
    });
  });
});

describe("a bot that publishes one of our names", () => {
  const sentTo = () =>
    sendRaw.mock.calls.map(([, line]: string[]) => {
      const tag = /\+draft\/bot-cmd=(\S+) TAGMSG/.exec(line);
      return tag ? JSON.parse(base64DecodeUtf8(tag[1])) : line;
    });

  beforeEach(() => {
    useStore.setState({
      servers: [
        {
          ...server,
          botCommands: { helpbot: [{ name: "list" }, { name: "close" }] },
        } as never,
      ],
    });
  });

  it("is reached only by naming it", () => {
    run("/list");
    expect(actions.openPage).toHaveBeenCalledTimes(1);
    run("/close");
    expect(actions.leaveChannel).toHaveBeenCalledWith("s1", "#lounge");
    expect(sendRaw).not.toHaveBeenCalled();

    run("/list@HelpBot");
    expect(sentTo()).toMatchObject([{ name: "list", bot: "HelpBot" }]);
    expect(actions.openPage).toHaveBeenCalledTimes(1);
  });
});

describe("commands the client already had", () => {
  it("still leaves a channel on /part", () => {
    run("/part");
    expect(actions.leaveChannel).toHaveBeenCalledWith("s1", "#lounge");
  });

  it("still sends an unknown command to the server", () => {
    run("/foo bar");
    run("/quote one\ntwo");
    expect(sendRaw.mock.calls).toEqual([
      ["s1", "foo bar"],
      ["s1", "quote one two"],
    ]);
    expect(rows()).toEqual([]);
  });
});
