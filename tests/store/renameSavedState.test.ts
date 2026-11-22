import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { saveLeftReason } from "../../src/lib/leftChannels";
import { muteChat, resetMutesForTests, silencesFor } from "../../src/lib/mutes";
import { getRecentPlaces, recordPlace } from "../../src/lib/search/recents";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { useChannelFolders } from "../../src/store/channelFolders";
import { readyProcessedServers } from "../../src/store/handlers/connection";
import { generateDeterministicId } from "../../src/store/helpers";
import type { MentionEntry } from "../../src/store/mentionLog";
import type { UISelections } from "../../src/store/types";
import type { Channel, ServerConfig, User } from "../../src/types";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

let serverId = "";
let counter = 0;
let sendRaw: ReturnType<typeof vi.spyOn>;

const member = (username: string): User =>
  ({ id: username, username, isOnline: true }) as User;

const channelRow = (name: string): Channel =>
  ({
    id: generateDeterministicId(serverId, name),
    name,
    isPrivate: false,
    serverId,
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users: ["me", "op"].map(member),
  }) as Channel;

const clientServers = () =>
  (ircClient as unknown as { servers: Map<string, unknown> }).servers;
const capsDone = () =>
  (ircClient as unknown as { capNegotiationComplete: Map<string, boolean> })
    .capNegotiationComplete;

const saved = <T>(key: string): T => JSON.parse(lsBacking.get(key) ?? "null");
const savedEntry = (): ServerConfig =>
  saved<ServerConfig[]>("savedServers").find((s) => s.id === serverId) as never;

function saveEntry(entry: Partial<ServerConfig> = {}) {
  lsBacking.set(
    "savedServers",
    JSON.stringify([
      {
        id: serverId,
        host: "irc.test",
        port: 6697,
        nickname: "me",
        channels: ["#Lounge", "#other"],
        ...entry,
      },
    ]),
  );
}

function connect(names: string[]) {
  ircClient.nicks.set(serverId, "me");
  capsDone().set(serverId, true);
  clientServers().set(serverId, {
    id: serverId,
    channels: names.map(channelRow).map((c) => ({ ...c, users: [] })),
    capabilities: [],
  });
}

function seed(names = ["#Lounge", "#other"]) {
  serverId = `rename-srv-${++counter}`;
  saveEntry();
  useStore.setState((state) => ({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 6697,
        channels: names.map(channelRow),
        privateChats: [],
        isConnected: true,
        users: [],
      },
    ],
    messages: {},
    activeBatches: {},
    channelOrder: {},
    mentionLog: [],
    ui: { ...state.ui, selectedServerId: serverId, perServerSelections: {} },
  })) as unknown as Partial<AppState>;
  useChannelFolders.setState({ folders: {} });
  connect(names);
}

function feed(line: string) {
  (
    ircClient as unknown as {
      handleMessage: (data: string, serverId: string) => void;
    }
  ).handleMessage(`${line}\r\n`, serverId);
}

// Hands the client the line that ends registration, as every new connection does.
function welcome() {
  readyProcessedServers.delete(serverId);
  feed(":irc.test 001 me :Welcome");
  (
    ircClient as unknown as { stopWebSocketPing: (serverId: string) => void }
  ).stopWebSocketPing(serverId);
}

// A fresh page: no channel rows anywhere until the saved entry brings them back.
function reload() {
  useStore.setState((state) => ({
    servers: state.servers.map((s) => ({ ...s, channels: [] })),
    mentionLog: saved<MentionEntry[]>("mentionLog") ?? state.mentionLog,
  }));
  connect([]);
  sendRaw.mockClear();
  welcome();
}

const server = () => useStore.getState().servers[0];
const rowNames = () => server().channels.map((c) => c.name);
const sentLines = () =>
  sendRaw.mock.calls.map((call: unknown[]) => call[1] as string);
// A new connection sends each join once from the saved list and once for the rows it then holds.
const sentJoins = () =>
  sentLines().filter((line: string) => line.startsWith("JOIN"));

describe("a channel the server renames", () => {
  beforeEach(() => {
    installLocalStorageBacking();
    sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
    capsDone().delete(serverId);
    clientServers().delete(serverId);
    readyProcessedServers.delete(serverId);
  });

  test("takes its place in the saved channel list under the new name", () => {
    feed(":op!u@h RENAME #lounge #den :tidying up");
    expect(savedEntry().channels).toEqual(["#den", "#other"]);
  });

  test("is the only one of the two names we join after a page load", () => {
    feed(":op!u@h RENAME #lounge #den");
    reload();
    expect(new Set(sentJoins())).toEqual(new Set(["JOIN #den", "JOIN #other"]));
    expect(rowNames()).toEqual(["#den", "#other"]);
  });

  test("is the only one of the two names we join after a reconnect", () => {
    feed(":op!u@h RENAME #lounge #den");
    sendRaw.mockClear();
    welcome();
    expect(sentJoins().some((line: string) => /#lounge/i.test(line))).toBe(
      false,
    );
    expect(sentJoins()).toContain("JOIN #den");
  });

  test("gets what we say next under the new name", () => {
    const { id } = server().channels[0];
    feed(":op!u@h RENAME #lounge #den");
    sendRaw.mockClear();
    ircClient.sendMessage(serverId, id, "hello");
    expect(sentLines()).toEqual(["PRIVMSG #den :hello"]);
  });

  test("is saved once when only the letter case changes", () => {
    feed(":op!u@h RENAME #Lounge #LOUNGE");
    expect(savedEntry().channels).toEqual(["#LOUNGE", "#other"]);
    expect(rowNames()).toEqual(["#LOUNGE", "#other"]);
    reload();
    expect(new Set(sentJoins())).toEqual(
      new Set(["JOIN #LOUNGE", "JOIN #other"]),
    );
  });

  test("is saved once when the saved list already holds the new name", () => {
    saveEntry({ channels: ["#Lounge", "#other", "#Den"] });
    feed(":op!u@h RENAME #lounge #den");
    expect(savedEntry().channels).toEqual(["#den", "#other"]);
  });

  test("leaves a saved list alone that never held it", () => {
    saveEntry({ channels: ["#other"] });
    feed(":op!u@h RENAME #lounge #den");
    expect(savedEntry().channels).toEqual(["#other"]);
  });

  test("leaves the saved entry alone when the new name is one no server holds", () => {
    feed(":op!u@h RENAME #lounge den");
    expect(savedEntry().channels).toEqual(["#Lounge", "#other"]);
  });

  test("keeps its place in the channel order", () => {
    useStore.setState({ channelOrder: { [serverId]: ["#other", "#Lounge"] } });
    feed(":op!u@h RENAME #lounge #den");
    expect(useStore.getState().channelOrder[serverId]).toEqual([
      "#other",
      "#den",
    ]);
    expect(saved<Record<string, string[]>>("channelOrder")[serverId]).toEqual([
      "#other",
      "#den",
    ]);
  });

  test("stays in its folder", () => {
    const folderId = useChannelFolders
      .getState()
      .createFolder(serverId, "Work", "#Lounge");
    feed(":op!u@h RENAME #lounge #den");
    const folder = useChannelFolders
      .getState()
      .folders[serverId].find((f) => f.id === folderId);
    expect(folder?.channels).toEqual(["#den"]);
    expect(
      saved<Record<string, { channels: string[] }[]>>("channelFolders")[
        serverId
      ][0].channels,
    ).toEqual(["#den"]);
  });

  test("stays the channel the next page load opens", () => {
    const { id } = server().channels[0];
    useStore.getState().selectChannel(id);
    expect(
      saved<UISelections>("uiSelections").perServerSelections[serverId]
        .selectedChannelName,
    ).toBe("#Lounge");

    feed(":op!u@h RENAME #lounge #den");

    expect(
      useStore.getState().ui.perServerSelections[serverId].selectedChannelName,
    ).toBe("#den");
    const selections = saved<UISelections>("uiSelections");
    expect(selections.perServerSelections[serverId].selectedChannelName).toBe(
      "#den",
    );
    expect(selections.lastSelection?.channelName).toBe("#den");
  });

  test("leaves the saved selection of another channel alone", () => {
    useStore.getState().selectChannel(server().channels[1].id);
    feed(":op!u@h RENAME #lounge #den");
    const selections = saved<UISelections>("uiSelections");
    expect(selections.perServerSelections[serverId].selectedChannelName).toBe(
      "#other",
    );
    expect(selections.lastSelection?.channelName).toBe("#other");
  });

  test("replaces a row we had left under the new name and is joined after a page load", () => {
    seed(["#Lounge", "#den"]);
    saveEntry({ channels: ["#Lounge", "#den"] });
    saveLeftReason(serverId, "#den", "parted");
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        channels: s.channels.map((c) =>
          c.name === "#den" ? { ...c, leftReason: "parted" as const } : c,
        ),
      })),
    }));
    const { id } = server().channels[0];

    feed(":op!u@h RENAME #lounge #Den");

    expect(server().channels.map((c) => [c.id, c.name])).toEqual([
      [id, "#Den"],
    ]);
    expect(savedEntry().channels).toEqual(["#Den"]);
    expect(savedEntry().leftChannels).toEqual({});
    reload();
    expect(new Set(sentJoins())).toEqual(new Set(["JOIN #Den"]));
    expect(server().channels[0].leftReason).toBeUndefined();
  });

  test("keeps its entry in the recent places", () => {
    recordPlace({ serverId, name: "#other", kind: "channel" });
    recordPlace({ serverId, name: "#Lounge", kind: "channel" });
    recordPlace({ serverId: "elsewhere", name: "#lounge", kind: "channel" });
    feed(":op!u@h RENAME #lounge #den");
    expect(getRecentPlaces()).toEqual([
      { serverId: "elsewhere", name: "#lounge", kind: "channel" },
      { serverId, name: "#den", kind: "channel" },
      { serverId, name: "#other", kind: "channel" },
    ]);
  });

  test("keeps its logged mentions on the row a page load gives it", () => {
    const { id } = server().channels[0];
    useStore.setState({
      mentionLog: [
        {
          messageId: "m1",
          msgid: "id1",
          serverId,
          channelId: id,
          channelName: "#Lounge",
          sender: "op",
          content: "me: hello",
          timestamp: "2026-01-01T12:00:00.000Z",
          seen: false,
        },
      ],
    });
    feed(":op!u@h RENAME #lounge #den");
    expect(saved<MentionEntry[]>("mentionLog")[0]).toMatchObject({
      channelId: id,
      channelName: "#den",
    });

    reload();
    ircClient.triggerEvent("JOIN", {
      serverId,
      username: "me",
      channelName: "#den",
    });

    const row = server().channels.find((c) => c.name === "#den");
    expect(row?.id).not.toBe(id);
    expect(useStore.getState().mentionLog[0]).toMatchObject({
      channelId: row?.id,
      channelName: "#den",
    });
  });

  describe("only when the rename is ours to follow", () => {
    const everything = () => ({
      rows: server().channels.map((c) => [c.name, c.leftReason]),
      known: (
        clientServers().get(serverId) as { channels: Channel[] }
      ).channels.map((c) => c.name),
      saved: savedEntry(),
      order: useStore.getState().channelOrder,
      folders: useChannelFolders.getState().folders,
      selections: saved<UISelections>("uiSelections"),
      places: getRecentPlaces(),
      mutes: silencesFor(server()),
      mentions: useStore.getState().mentionLog,
      said: Object.values(useStore.getState().messages).flat(),
    });
    const mention = (name: string): MentionEntry => ({
      messageId: `m-${name}`,
      serverId,
      channelId: generateDeterministicId(serverId, name),
      channelName: name,
      sender: "op",
      content: "me: hello",
      timestamp: "2026-01-01T12:00:00.000Z",
      seen: false,
    });

    beforeEach(() => {
      resetMutesForTests();
      seed(["#Lounge", "#other"]);
      useStore.setState({
        channelOrder: { [serverId]: ["#Lounge", "#other"] },
        mentionLog: [mention("#Lounge"), mention("#other")],
      });
      useChannelFolders.getState().createFolder(serverId, "Work", "#Lounge");
      useStore.getState().selectChannel(server().channels[0].id);
      recordPlace({ serverId, name: "#Lounge", kind: "channel" });
      muteChat(
        serverId,
        { id: server().channels[0].id, kind: "channel", name: "#Lounge" },
        null,
      );
    });

    test("carries all of it for a channel we are in", () => {
      feed(":op!u@h RENAME #lounge #den");
      const after = everything();
      expect(after.rows).toEqual([
        ["#den", undefined],
        ["#other", undefined],
      ]);
      expect(after.known).toEqual(["#den", "#other"]);
      expect(after.saved.channels).toEqual(["#den", "#other"]);
      expect(after.order[serverId]).toEqual(["#den", "#other"]);
      expect(after.folders[serverId][0].channels).toEqual(["#den"]);
      expect(
        after.selections.perServerSelections[serverId].selectedChannelName,
      ).toBe("#den");
      expect(after.places[0].name).toBe("#den");
      expect(after.mutes).toEqual([{ chat: "#den", until: null }]);
      expect(after.mentions.map((m) => m.channelName)).toEqual([
        "#den",
        "#other",
      ]);
    });

    test("changes nothing when the line is part of a history page", () => {
      const before = everything();
      feed(":irc.test BATCH +h1 chathistory #other");
      feed("@batch=h1 :op!u@h RENAME #Lounge #den");
      feed(":irc.test BATCH -h1");
      expect(everything()).toEqual(before);
    });

    test("changes nothing for a channel we hold no row for", () => {
      saveEntry({ channels: ["#Lounge", "#other", "#ghost"] });
      saveLeftReason(serverId, "#gone", "parted");
      recordPlace({ serverId, name: "#ghost", kind: "channel" });
      muteChat(serverId, { id: "x", kind: "channel", name: "#ghost" }, null);
      const before = everything();
      feed(":op!u@h RENAME #ghost #gone");
      expect(everything()).toEqual(before);
      expect(savedEntry().leftChannels).toEqual({ "#gone": "parted" });
    });

    test("changes nothing for a channel we have left", () => {
      ircClient.triggerEvent("PART", {
        serverId,
        username: "me",
        channelName: "#lounge",
      });
      expect(server().channels[0].leftReason).toBe("parted");
      const before = everything();
      feed(":op!u@h RENAME #lounge #den");
      expect(everything()).toEqual(before);
    });

    test("changes nothing when the new name is another channel we are in", () => {
      const before = everything();
      feed(":op!u@h RENAME #lounge #OTHER");
      expect(everything()).toEqual(before);
    });
  });
});
