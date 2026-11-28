import { beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { playNotificationSound } from "../../src/lib/notificationSounds";
import { showChatNotification } from "../../src/lib/notifications";
import useStore from "../../src/store";
import {
  registerServerReplyHandlers,
  reportServerReply,
  showCommandReply,
} from "../../src/store/handlers/serverReplies";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: vi.fn(() => true),
}));

vi.mock("../../src/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/notifications")>()),
  showChatNotification: vi.fn(),
}));

const serverId = "s1";
const reply = {
  serverId,
  type: "fail" as const,
  command: "MARKREAD",
  code: "ACCOUNT_REQUIRED",
  message: "You need an account",
};

function seedServer() {
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.example.com",
        port: 443,
        channels: [],
        privateChats: [],
        isConnected: true,
        users: [],
      } as never,
    ],
    messages: {},
    serverAlerts: {},
    unreadServerNotices: {},
    globalNotifications: [],
  });
}

function notices() {
  return useStore.getState().messages[`${serverId}-server-notices`] ?? [];
}

function expectQuiet() {
  const state = useStore.getState();
  expect(playNotificationSound).not.toHaveBeenCalled();
  expect(showChatNotification).not.toHaveBeenCalled();
  expect(state.globalNotifications).toHaveLength(0);
  expect(state.servers[0].channels.some((c) => c.isMentioned)).toBe(false);
  expect(state.servers[0].privateChats).toHaveLength(0);
  expect(state.unreadServerNotices[serverId]).toBe(true);
}

describe("server notices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedServer();
    vi.spyOn(ircClient, "getCurrentUser").mockReturnValue({
      username: "me",
    } as never);
  });

  test("counts a failure as a problem without a sound or a toast", () => {
    document.dispatchEvent(new KeyboardEvent("keydown"));
    reportServerReply(useStore, reply);
    reportServerReply(useStore, { ...reply, type: "note", message: "FYI" });
    expect(notices()).toHaveLength(2);
    expect(notices()[0].standardReplyType).toBe("FAIL");
    expect(useStore.getState().serverAlerts[serverId]).toBe(1);
    expectQuiet();
  });

  test("files a dropped connection as a note without counting it as a problem", () => {
    ircClient.triggerEvent("serverError", {
      serverId,
      message: "Closing Link: me[127.0.0.1] (Registration Timeout)",
    });
    expect(notices()).toHaveLength(1);
    expect(notices()[0].standardReplyType).toBe("NOTE");
    expect(useStore.getState().serverAlerts[serverId] ?? 0).toBe(0);
  });

  test("keeps a server's welcome notice naming a command quiet", () => {
    ircClient.triggerEvent("USERNOTICE", {
      serverId,
      mtags: undefined,
      sender: "irc.example.com",
      message: "   /CATFACT - Learn about cats, me",
      timestamp: new Date(),
    });
    expect(notices()[0].content).toContain("/CATFACT");
    expect(useStore.getState().serverAlerts[serverId]).toBeUndefined();
    expectQuiet();
  });

  test("keeps a server command's private reply quiet", () => {
    ircClient.triggerEvent("USERMSG", {
      serverId,
      mtags: undefined,
      sender: "irc.example.com",
      target: "me",
      message: "Cat Fact: me, cats sleep a lot",
      timestamp: new Date(),
    });
    expect(notices()).toHaveLength(1);
    expect(useStore.getState().serverAlerts[serverId]).toBeUndefined();
    expectQuiet();
  });
});

describe("server notices unread marks", () => {
  test("clears once the user looks at the server notices", () => {
    seedServer();
    registerServerReplyHandlers(useStore);
    reportServerReply(useStore, reply);
    expect(useStore.getState().unreadServerNotices[serverId]).toBe(true);
    expect(useStore.getState().serverAlerts[serverId]).toBe(1);
    useStore.setState((state) => ({
      ui: {
        ...state.ui,
        isNarrowView: false,
        selectedServerId: serverId,
        perServerSelections: {
          ...state.ui.perServerSelections,
          [serverId]: {
            selectedChannelId: "server-notices",
            selectedPrivateChatId: null,
          },
        },
      },
    }));
    expect(useStore.getState().unreadServerNotices[serverId]).toBe(false);
    expect(useStore.getState().serverAlerts[serverId]).toBe(0);
  });
});

describe("the answer to a typed command", () => {
  const refusal = {
    serverId,
    type: "fail" as const,
    command: "QUERY",
    code: "USAGE",
    message: "Not run. Type it as /query <user>",
  };
  const inChat = () => useStore.getState().messages[`${serverId}-c1`] ?? [];

  beforeEach(() => {
    vi.clearAllMocks();
    seedServer();
  });

  test("is one row in the chat where it was typed, and nothing else", () => {
    showCommandReply(useStore, refusal, "c1");

    expect(inChat()).toMatchObject([
      {
        type: "standard-reply",
        channelId: "c1",
        standardReplyType: "FAIL",
        standardReplyCommand: "QUERY",
        standardReplyCode: "USAGE",
        standardReplyMessage: "Not run. Type it as /query <user>",
      },
    ]);
    const state = useStore.getState();
    expect(notices()).toHaveLength(0);
    expect(state.serverAlerts).toEqual({});
    expect(state.unreadServerNotices).toEqual({});
    expect(state.globalNotifications).toHaveLength(0);
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  test("goes below a line the server stamped ahead of the device clock", () => {
    const ahead = new Date(Date.now() + 60 * 60 * 1000);
    useStore.setState({
      messages: {
        [`${serverId}-c1`]: [
          { id: "m1", type: "message", content: "hi", timestamp: ahead },
        ] as never,
      },
    });

    showCommandReply(useStore, refusal, "c1");

    expect(inChat().map((m) => m.type)).toEqual(["message", "standard-reply"]);
    expect(new Date(inChat()[1].timestamp).getTime()).toBe(ahead.getTime() + 1);
  });
});
