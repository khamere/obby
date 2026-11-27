import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../src/store";
import type { Message } from "../../src/types";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: vi.fn(() => false),
}));
const notifications = vi.hoisted(() => ({
  closeChatNotification: vi.fn(),
}));
vi.mock("../../src/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...notifications,
}));

const SERVER = "srv";
const KEY = `${SERVER}-chan-1`;
const BASE = Date.parse("2026-01-01T12:00:00.000Z");

const message = (index: number, userId = "alice"): Message =>
  ({
    id: `m${index}`,
    msgid: `m${index}`,
    type: "message",
    content: `line ${index}`,
    timestamp: new Date(BASE + index * 1000),
    userId,
    channelId: "chan-1",
    serverId: SERVER,
    reactions: [],
    replyMessage: null,
    mentioned: [],
  }) as Message;

async function boot({
  selected,
  readMarker = new Date(BASE + 1000).toISOString(),
}: {
  selected: boolean;
  readMarker?: string;
}) {
  vi.resetModules();
  const { default: useStore } = await import("../../src/store");
  const { default: ircClient } = await import("../../src/lib/ircClient");
  const helpers = await import("../../src/store/helpers");
  vi.spyOn(ircClient, "getCurrentUser").mockReturnValue({
    id: "tester",
    username: "tester",
    account: "tester",
    isOnline: true,
  });
  vi.spyOn(ircClient, "getNick").mockReturnValue("tester");
  const markreadSet = vi
    .spyOn(ircClient, "markreadSet")
    .mockImplementation(() => {});
  useStore.setState(
    (state) =>
      ({
        servers: [
          {
            id: SERVER,
            name: "TestNet",
            host: "irc.test",
            port: 6667,
            isConnected: true,
            isRegistered: true,
            capabilities: ["draft/read-marker"],
            account: "me",
            privateChats: [],
            channels: [
              {
                id: "chan-1",
                name: "#chan",
                isPrivate: false,
                serverId: SERVER,
                unreadCount: 3,
                readMarker,
                mentionCount: 1,
                isMentioned: true,
                messages: [],
                users: [],
              },
            ],
          },
        ],
        messages: { [KEY]: [message(1), message(2), message(3)] },
        ui: {
          ...state.ui,
          isNarrowView: false,
          selectedServerId: selected ? SERVER : null,
          perServerSelections: {
            [SERVER]: {
              selectedChannelId: selected ? "chan-1" : null,
              selectedPrivateChatId: null,
            },
          },
        },
      }) as unknown as AppState,
  );
  const channel = () => useStore.getState().servers[0].channels[0];
  return { useStore, ircClient, helpers, markreadSet, channel };
}

afterEach(() => {
  vi.useRealTimers();
  notifications.closeChatNotification.mockClear();
});

describe("read markers", () => {
  it("marks every chat with unread lines read from the Read all button", async () => {
    const { useStore, markreadSet, channel } = await boot({ selected: false });
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        channels: [
          ...s.channels,
          {
            ...s.channels[0],
            id: "chan-2",
            name: "#quiet",
            unreadCount: 0,
            mentionCount: 0,
            isMentioned: false,
          },
        ],
      })),
    }));
    useStore.getState().markAllRead();
    expect(markreadSet).toHaveBeenCalledTimes(1);
    expect(markreadSet).toHaveBeenCalledWith(
      SERVER,
      "#chan",
      new Date(BASE + 3000).toISOString(),
    );
    expect(channel()).toMatchObject({ unreadCount: 0, isMentioned: false });
  });

  it("puts the new messages line above the first message from someone else after the marker", async () => {
    const { helpers } = await boot({ selected: false });
    const messages = [message(1), message(2, "tester"), message(3)];
    expect(helpers.firstUnreadMessageId(messages, BASE + 1000, "Tester")).toBe(
      "m3",
    );
    expect(
      helpers.firstUnreadMessageId(messages, BASE + 3000, "tester"),
    ).toBeUndefined();
  });

  it("clears unread and mentions once another client read past the newest message", async () => {
    const { ircClient, channel } = await boot({ selected: false });
    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "#chan",
      timestamp: new Date(BASE + 2000).toISOString(),
    });
    expect(channel().unreadCount).toBe(1);
    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "#CHAN",
      timestamp: new Date(BASE + 3000).toISOString(),
    });
    expect(channel()).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
      isMentioned: false,
    });
    expect(notifications.closeChatNotification).toHaveBeenCalledWith(
      SERVER,
      "#CHAN",
    );
  });

  it("marks mentions under a marker another device set as seen", async () => {
    const { useStore, ircClient } = await boot({ selected: false });
    const mention = (id: string, offset: number) => ({
      messageId: id,
      msgid: id,
      serverId: SERVER,
      channelId: "chan-1",
      channelName: "#chan",
      sender: "alice",
      content: "tester: hi",
      timestamp: new Date(BASE + offset).toISOString(),
      seen: false,
    });
    useStore.setState({
      mentionLog: [
        mention("m1", 1500),
        mention("m2", 2500),
        { ...mention("m3", 1500), channelId: "gone", channelName: "#left" },
      ],
    });
    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "#CHAN",
      timestamp: new Date(BASE + 2000).toISOString(),
    });
    expect(useStore.getState().mentionLog.map((m) => m.seen)).toEqual([
      true,
      false,
      false,
    ]);
    // A channel we left keeps its inbox entries, and a marker still reaches them.
    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "#left",
      timestamp: new Date(BASE + 2000).toISOString(),
    });
    expect(useStore.getState().mentionLog[2].seen).toBe(true);
  });

  it("stores a start for a channel the server has no marker for, so the next launch keeps what arrived meanwhile unread", async () => {
    const { useStore, ircClient, markreadSet, channel } = await boot({
      selected: false,
      readMarker: undefined as unknown as string,
    });
    useStore.setState({ messages: {} });
    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "#chan",
      timestamp: null,
    });
    const start = channel().readMarker;
    expect(markreadSet).toHaveBeenCalledWith(SERVER, "#chan", start);
    expect(notifications.closeChatNotification).not.toHaveBeenCalled();

    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "#chan",
      timestamp: new Date(BASE).toISOString(),
    });
    expect(notifications.closeChatNotification).not.toHaveBeenCalled();
    useStore.setState({ messages: { [KEY]: [message(1)] } });
    expect(channel()).toMatchObject({ unreadCount: 1, isMentioned: false });
  });

  it("sends no start marker for a guest, since the server keeps markers only for accounts", async () => {
    const { useStore, ircClient, markreadSet } = await boot({
      selected: false,
      readMarker: undefined as unknown as string,
    });
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({ ...s, account: undefined })),
    }));
    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "#chan",
      timestamp: null,
    });
    expect(markreadSet).not.toHaveBeenCalled();
  });

  it("marks the chat read up to its newest message once the user sees it", async () => {
    vi.useFakeTimers();
    const { useStore, markreadSet, channel } = await boot({ selected: true });
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [KEY]: [...state.messages[KEY], message(4)],
      },
    }));
    vi.advanceTimersByTime(1000);
    expect(markreadSet).toHaveBeenCalledWith(
      SERVER,
      "#chan",
      new Date(BASE + 4000).toISOString(),
    );
    expect(channel().unreadCount).toBe(0);
  });

  it("leaves the marker alone while the chat is scrolled up", async () => {
    vi.useFakeTimers();
    const { useStore, markreadSet } = await boot({ selected: true });
    useStore.setState((state) => ({
      ui: { ...state.ui, isChatAwayFromPresent: true },
      messages: {
        ...state.messages,
        [KEY]: [...state.messages[KEY], message(4)],
      },
    }));
    vi.advanceTimersByTime(1000);
    expect(markreadSet).not.toHaveBeenCalled();

    useStore.setState((state) => ({
      ui: { ...state.ui, isChatAwayFromPresent: false },
    }));
    vi.advanceTimersByTime(1000);
    expect(markreadSet).toHaveBeenCalledWith(
      SERVER,
      "#chan",
      new Date(BASE + 4000).toISOString(),
    );
  });

  it("marks the chat read when the user sends to it, even while scrolled up", async () => {
    const { useStore, ircClient, markreadSet, channel } = await boot({
      selected: true,
    });
    useStore.setState((state) => ({
      ui: { ...state.ui, isChatAwayFromPresent: true },
    }));

    ircClient.triggerEvent("rawLine", {
      serverId: SERVER,
      direction: "tx",
      line: "PRIVMSG #chan :on it",
    });

    const newest = new Date(BASE + 3000).toISOString();
    expect(channel().readMarker).toBe(newest);
    expect(channel().unreadCount).toBe(0);
    expect(markreadSet).toHaveBeenCalledWith(SERVER, "#chan", newest);
  });

  it("marks the chat read after a multiline batch has closed, never inside it", async () => {
    const { useStore, ircClient, markreadSet } = await boot({
      selected: true,
    });
    useStore.setState((state) => ({
      ui: { ...state.ui, isChatAwayFromPresent: true },
    }));
    const send = (line: string) =>
      ircClient.triggerEvent("rawLine", {
        serverId: SERVER,
        direction: "tx",
        line,
      });

    send("@+reply=abc BATCH +ml1 draft/multiline #chan");
    send("@batch=ml1 PRIVMSG #chan :one");
    send("@batch=ml1;draft/multiline-concat PRIVMSG #chan :two");
    expect(markreadSet).not.toHaveBeenCalled();

    send("BATCH -ml1");
    expect(markreadSet).toHaveBeenCalledExactlyOnceWith(
      SERVER,
      "#chan",
      new Date(BASE + 3000).toISOString(),
    );
  });

  it("leaves the chat as it is when a line leaves long after the user sent it", async () => {
    const { ircClient, markreadSet } = await boot({ selected: true });
    const send = (line: string, afterWaiting?: boolean) =>
      ircClient.triggerEvent("rawLine", {
        serverId: SERVER,
        direction: "tx",
        line,
        afterWaiting,
      });

    send("PRIVMSG #chan :pasted earlier", true);
    send("BATCH +ml2 draft/multiline #chan", true);
    send("@batch=ml2 PRIVMSG #chan :one", true);
    send("BATCH -ml2", true);
    expect(markreadSet).not.toHaveBeenCalled();

    send("PRIVMSG #chan :typed now");
    expect(markreadSet).toHaveBeenCalledTimes(1);
    // The batch that waited is closed for us too, so its id marks nothing later.
    send("BATCH -ml2");
    expect(markreadSet).toHaveBeenCalledTimes(1);
  });

  it("marks the chat read when the user sends a line that has to wait", async () => {
    const { ircClient, markreadSet } = await boot({ selected: true });
    const queue = (line: string) =>
      ircClient.triggerEvent("lineQueued", { serverId: SERVER, line });

    queue("PRIVMSG #chan :typed behind a paste");
    expect(markreadSet).toHaveBeenCalledTimes(1);
  });

  it("marks the chat read once the whole of a batch has joined the wait", async () => {
    const { ircClient, markreadSet } = await boot({ selected: true });
    const queue = (line: string) =>
      ircClient.triggerEvent("lineQueued", { serverId: SERVER, line });

    queue("BATCH +ml3 draft/multiline #chan");
    queue("@batch=ml3 PRIVMSG #chan :one");
    expect(markreadSet).not.toHaveBeenCalled();
    queue("BATCH -ml3");
    expect(markreadSet).toHaveBeenCalledTimes(1);
  });

  it("marks our own line read at the time the server stored it, never at the time we sent it", async () => {
    const { useStore, ircClient, markreadSet } = await boot({
      selected: true,
    });
    const serverTime = new Date(BASE + 9000).toISOString();
    const sending = {
      ...message(5, "tester"),
      timestamp: new Date(BASE + 8000),
      status: "pending",
    } as Message;
    useStore.setState((state) => ({
      ui: { ...state.ui, isChatAwayFromPresent: true },
      messages: { ...state.messages, [KEY]: [...state.messages[KEY], sending] },
    }));
    const sendLine = {
      serverId: SERVER,
      direction: "tx" as const,
      line: "PRIVMSG #chan :on it",
    };

    ircClient.triggerEvent("rawLine", sendLine);
    expect(markreadSet).toHaveBeenLastCalledWith(
      SERVER,
      "#chan",
      new Date(BASE + 3000).toISOString(),
    );

    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [KEY]: state.messages[KEY].map((m) =>
          m.id === "m5"
            ? { ...m, status: undefined, tags: { time: serverTime } }
            : m,
        ),
      },
    }));
    ircClient.triggerEvent("rawLine", sendLine);
    expect(markreadSet).toHaveBeenLastCalledWith(SERVER, "#chan", serverTime);
  });

  it("waits for the stored marker before sending its own", async () => {
    vi.useFakeTimers();
    const { useStore, markreadSet } = await boot({ selected: true });
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        channels: server.channels.map((channel) => ({
          ...channel,
          readMarker: undefined,
        })),
      })),
    }));
    vi.advanceTimersByTime(1000);
    expect(markreadSet).not.toHaveBeenCalled();
  });

  // A network bound through a bouncer keeps its account while its connection
  // is away, so the server still counts as one that stores markers.
  const bootBoundNetwork = async () => {
    const booted = await boot({ selected: false });
    const { useStore, ircClient } = booted;
    const markreadGet = vi
      .spyOn(ircClient, "markreadGet")
      .mockImplementation(() => {});
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    useStore.setState((state) => ({
      servers: [
        ...state.servers.map((server) => ({
          ...server,
          bouncerServerId: "control",
          bouncerNetid: "1",
          privateChats: [
            {
              id: "pm-service",
              username: "service",
              serverId: SERVER,
              unreadCount: 0,
              isMentioned: false,
              readMarker: null,
              readMarkerFetched: true,
            },
          ],
        })),
        {
          id: "control",
          name: "bouncer",
          host: "irc.test",
          port: 6667,
          isConnected: true,
          isRegistered: true,
          isBouncerControl: true,
          capabilities: ["draft/read-marker"],
          account: "me",
          channels: [],
          privateChats: [],
          users: [],
        },
      ],
      messages: {
        ...state.messages,
        [`${SERVER}-pm-service`]: [
          { ...message(2, "service"), channelId: "pm-service" },
        ],
      },
    }));
    const state = (connectionState: string) =>
      ircClient.triggerEvent("connectionStateChange", {
        serverId: SERVER,
        connectionState,
      } as never);
    const drop = () => {
      state("disconnected");
      state("reconnecting");
    };
    const welcome = () => {
      state("connecting");
      state("connected");
      ircClient.triggerEvent("ready", {
        serverId: SERVER,
        serverName: "irc.test",
        nickname: "tester",
      });
      ircClient.triggerEvent("parsedLine", {
        serverId: SERVER,
        line: ":irc.test 001 tester :Welcome",
        command: "001",
        source: "irc.test",
        parv: ["tester", "Welcome"],
        mtags: undefined,
      });
    };
    const answer = (target: string, timestamp: string | null) =>
      ircClient.triggerEvent("MARKREAD", {
        serverId: SERVER,
        target,
        timestamp,
      } as never);
    const service = () => useStore.getState().servers[0].privateChats?.[0];
    return { ...booted, markreadGet, drop, welcome, answer, service };
  };
  const STORED = new Date(BASE + 1000).toISOString();
  const READ = new Date(BASE + 3000).toISOString();

  const markReadWhileAway = async (action: "one" | "all") => {
    const booted = await bootBoundNetwork();
    const { useStore, markreadSet, channel, drop } = booted;
    drop();
    expect(useStore.getState().servers[0].account).toBe("me");
    if (action === "all") useStore.getState().markAllRead();
    else useStore.getState().markChannelAsRead(SERVER, "chan-1");
    expect(markreadSet).not.toHaveBeenCalled();
    expect(channel()).toMatchObject({
      unreadCount: 0,
      isMentioned: false,
      readMarker: READ,
    });
    return booted;
  };

  it("clears a chat marked read while its connection is away and sends the marker once the server names its own", async () => {
    const { markreadSet, channel, welcome, answer } =
      await markReadWhileAway("one");
    welcome();
    answer("#chan", STORED);

    expect(markreadSet.mock.calls).toEqual([[SERVER, "#chan", READ]]);
    expect(channel().unreadCount).toBe(0);

    answer("#chan", READ);
    expect(markreadSet).toHaveBeenCalledTimes(1);
  });

  it("drops a marker from while the connection was away when another client read further", async () => {
    const { markreadSet, channel, welcome, answer } =
      await markReadWhileAway("all");
    const further = new Date(BASE + 5000).toISOString();
    welcome();
    answer("#chan", further);

    expect(markreadSet).not.toHaveBeenCalledWith(SERVER, "#chan", READ);
    expect(channel().readMarker).toBe(further);
  });

  it("sends a waiting marker again when the connection drops before the server stored it", async () => {
    const { markreadSet, channel, drop, welcome, answer } =
      await markReadWhileAway("one");
    welcome();
    answer("#chan", STORED);
    expect(markreadSet).toHaveBeenCalledTimes(1);

    drop();
    welcome();
    answer("#chan", STORED);
    expect(markreadSet.mock.calls).toEqual([
      [SERVER, "#chan", READ],
      [SERVER, "#chan", READ],
    ]);
    expect(channel()).toMatchObject({ unreadCount: 0, readMarker: READ });

    answer("#chan", READ);
    drop();
    welcome();
    answer("#chan", READ);
    expect(markreadSet).toHaveBeenCalledTimes(2);
  });

  it("asks at the welcome for a channel whose marker is waiting", async () => {
    const { markreadGet, welcome } = await markReadWhileAway("one");
    welcome();
    expect(markreadGet).toHaveBeenCalledWith(SERVER, "#chan");
  });

  it("keeps a chat read when the server stores no marker for it", async () => {
    const { useStore, markreadSet, service, drop, welcome, answer } =
      await bootBoundNetwork();
    expect(service()?.unreadCount).toBe(1);
    drop();
    useStore.getState().markAllRead();
    const read = new Date(BASE + 2000).toISOString();
    expect(service()).toMatchObject({ unreadCount: 0, readMarker: read });

    welcome();
    answer("service", null);
    answer("service", null);
    expect(
      markreadSet.mock.calls.filter(([, target]) => target === "service"),
    ).toEqual([[SERVER, "service", read]]);
    expect(service()).toMatchObject({ unreadCount: 0, readMarker: read });
  });

  it("keeps a newer read made while the server's older marker is still on its way", async () => {
    const { useStore, markreadSet, channel, drop, welcome, answer } =
      await markReadWhileAway("one");
    welcome();
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [KEY]: [...state.messages[KEY], message(4)],
      },
    }));
    useStore.getState().markChannelAsRead(SERVER, "chan-1");
    const newer = new Date(BASE + 4000).toISOString();
    expect(markreadSet.mock.calls).toEqual([[SERVER, "#chan", newer]]);

    answer("#chan", STORED);
    expect(markreadSet).toHaveBeenCalledTimes(1);
    expect(channel()).toMatchObject({ unreadCount: 0, readMarker: newer });

    drop();
    welcome();
    answer("#chan", STORED);
    expect(markreadSet.mock.calls).toEqual([
      [SERVER, "#chan", newer],
      [SERVER, "#chan", newer],
    ]);
    expect(channel()).toMatchObject({ unreadCount: 0, readMarker: newer });
  });

  it("keeps a chat read while connected when the server stores no marker for it", async () => {
    const { useStore, markreadSet, service, answer } = await bootBoundNetwork();
    useStore.getState().markAllRead();
    const read = new Date(BASE + 2000).toISOString();
    expect(markreadSet).toHaveBeenCalledWith(SERVER, "service", read);

    answer("service", null);
    expect(service()).toMatchObject({ unreadCount: 0, readMarker: read });
  });

  it("counts a private chat's older lines once a login shows the server stores no marker for it", async () => {
    const { useStore, ircClient } = await boot({ selected: false });
    vi.spyOn(ircClient, "markreadGet").mockImplementation(() => {});
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        account: undefined,
        privateChats: [
          {
            id: "pm-bob",
            username: "bob",
            serverId: SERVER,
            unreadCount: 0,
            isMentioned: false,
          },
        ],
      })),
      messages: {
        ...state.messages,
        [`${SERVER}-pm-bob`]: [{ ...message(1, "bob"), channelId: "pm-bob" }],
      },
    }));
    const bob = () => useStore.getState().servers[0].privateChats?.[0];
    ircClient.triggerEvent("parsedLine", {
      serverId: SERVER,
      line: ":irc.test 001 tester :Welcome",
      command: "001",
      source: "irc.test",
      parv: ["tester", "Welcome"],
      mtags: { time: new Date(BASE + 10000).toISOString() },
    });
    expect(bob()).toMatchObject({
      unreadCount: 0,
      readMarker: new Date(BASE + 10000).toISOString(),
    });

    ircClient.triggerEvent("LOGGED_IN", { serverId: SERVER, account: "me" });
    ircClient.triggerEvent("MARKREAD", {
      serverId: SERVER,
      target: "bob",
      timestamp: null,
    } as never);
    expect(bob()).toMatchObject({ unreadCount: 1, readMarker: null });
  });

  it("asks for a private chat's marker again after a logout and a new login", async () => {
    const { useStore, ircClient } = await boot({ selected: false });
    const markreadGet = vi
      .spyOn(ircClient, "markreadGet")
      .mockImplementation(() => {});
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        privateChats: [
          {
            id: "pm-bob",
            username: "bob",
            serverId: SERVER,
            unreadCount: 0,
            isMentioned: false,
            readMarker: new Date(BASE).toISOString(),
            readMarkerFetched: true,
          },
        ],
      })),
    }));
    ircClient.triggerEvent("parsedLine", {
      serverId: SERVER,
      line: ":irc.test 001 tester :Welcome",
      command: "001",
      source: "irc.test",
      parv: ["tester", "Welcome"],
      mtags: undefined,
    });
    expect(markreadGet).not.toHaveBeenCalledWith(SERVER, "bob");

    ircClient.triggerEvent("LOGGED_OUT", { serverId: SERVER } as never);
    ircClient.triggerEvent("LOGGED_IN", { serverId: SERVER, account: "other" });
    expect(
      markreadGet.mock.calls.filter(([, target]) => target === "bob"),
    ).toEqual([[SERVER, "bob"]]);
  });

  it("leaves the chats alone when an update touches neither chats nor messages", async () => {
    const { useStore } = await boot({ selected: false });
    const privateChats = [
      {
        id: "pm-bob",
        username: "bob",
        serverId: SERVER,
        unreadCount: 0,
        isMentioned: false,
        readMarker: null,
        readMarkerFetched: true,
      },
    ];
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({ ...server, privateChats })),
    }));
    const find = vi.spyOn(privateChats, "find");
    useStore.setState({ rawLog: { [SERVER]: [] } });
    expect(find).not.toHaveBeenCalled();
  });

  it("stops sending markers on a connection once the server refuses one", async () => {
    vi.useFakeTimers();
    const { useStore, ircClient, markreadSet } = await boot({ selected: true });
    ircClient.triggerEvent("MARKREAD_FAIL", {
      serverId: SERVER,
      mtags: undefined,
      code: "INTERNAL_ERROR",
      target: "#chan",
      message: "An account is required for MARKREAD.",
    });
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [KEY]: [...state.messages[KEY], message(4)],
      },
    }));
    vi.advanceTimersByTime(1000);
    expect(markreadSet).not.toHaveBeenCalled();
  });

  it("keeps markers local until the connection logs in, then asks for the stored ones", async () => {
    vi.useFakeTimers();
    const { useStore, ircClient, markreadSet, channel } = await boot({
      selected: true,
    });
    const markreadGet = vi
      .spyOn(ircClient, "markreadGet")
      .mockImplementation(() => {});
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        account: undefined,
        privateChats: [
          {
            id: "pm-bob",
            username: "bob",
            serverId: SERVER,
            unreadCount: 0,
            isMentioned: false,
          },
        ],
      })),
    }));
    ircClient.triggerEvent("parsedLine", {
      serverId: SERVER,
      line: ":irc.test 001 tester :Welcome",
      command: "001",
      source: "irc.test",
      parv: ["tester", "Welcome"],
      mtags: undefined,
    });
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [KEY]: [...state.messages[KEY], message(4)],
      },
    }));
    vi.advanceTimersByTime(1000);
    expect(markreadSet).not.toHaveBeenCalled();
    expect(markreadGet).not.toHaveBeenCalled();
    expect(channel().unreadCount).toBe(0);

    ircClient.triggerEvent("LOGGED_IN", { serverId: SERVER, account: "me" });
    expect([...markreadGet.mock.calls].sort()).toEqual([
      [SERVER, "#chan"],
      [SERVER, "bob"],
    ]);
  });

  it("leaves the marker alone while the app is hidden", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { useStore, markreadSet, channel } = await boot({ selected: true });
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [KEY]: [...state.messages[KEY], message(4)],
      },
    }));
    vi.advanceTimersByTime(1000);
    expect(markreadSet).not.toHaveBeenCalled();
    expect(channel().unreadCount).toBe(3);
    visibility.mockRestore();
  });

  it("counts messages from history after the marker as unread, as after a restart", async () => {
    const { useStore, channel } = await boot({ selected: false });
    useStore.setState({ messages: {} });
    expect(channel().unreadCount).toBe(0);

    useStore.setState({
      messages: { [KEY]: [message(1), message(2), message(3, "tester")] },
    });

    expect(channel()).toMatchObject({ unreadCount: 1, isMentioned: false });
  });

  it("marks a chat read when the user leaves it before the marker would go out", async () => {
    vi.useFakeTimers();
    const { useStore, markreadSet, channel } = await boot({ selected: true });
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [KEY]: [...state.messages[KEY], message(4)],
      },
    }));
    useStore.setState((state) => ({
      ui: { ...state.ui, selectedServerId: null },
    }));

    expect(markreadSet).toHaveBeenCalledWith(
      SERVER,
      "#chan",
      new Date(BASE + 4000).toISOString(),
    );
    expect(channel().unreadCount).toBe(0);
  });

  it("counts the first private message on a server without read markers", async () => {
    const { useStore, ircClient } = await boot({ selected: false });
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        capabilities: [],
        privateChats: [
          {
            id: "pm-bob",
            username: "bob",
            serverId: SERVER,
            unreadCount: 0,
            isMentioned: false,
          },
        ],
      })),
    }));
    ircClient.triggerEvent("parsedLine", {
      serverId: SERVER,
      line: ":irc.test 001 tester :Welcome",
      command: "001",
      source: "irc.test",
      parv: ["tester", "Welcome"],
      mtags: { time: new Date(Date.now() - 1000).toISOString() },
    });
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        [`${SERVER}-pm-bob`]: [{ ...message(1, "bob"), timestamp: new Date() }],
      },
    }));

    expect(useStore.getState().servers[0].privateChats?.[0]).toMatchObject({
      unreadCount: 1,
      mentionCount: 1,
      isMentioned: true,
    });
  });
});
