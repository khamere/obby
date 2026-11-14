import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  resetBridgeRulesForTests,
  saveOwnBridgeRules,
} from "../../src/lib/bridgeRules";
import ircClient from "../../src/lib/ircClient";
import { upstreamHostForServer } from "../../src/lib/networkHost";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import type { Channel, Server } from "../../src/types";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: () => false,
}));

const SID = "s1";
const CID = "c1";
const KEY = `${SID}-${CID}`;

const file = (rules: unknown[]) => JSON.stringify({ version: 1, rules });
const LST = { host: "irc.lst.gg", bot: "Bot", formats: ["[{nick}] {text}"] };
const IHD = {
  host: "irc.infinityhd.net",
  nickFormat: "({nick})",
  label: "web",
};

const channel = (): Channel => ({
  id: CID,
  name: "#general",
  isPrivate: false,
  serverId: SID,
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
});

function setup(host: string, bridgedUsers = true) {
  useStore.setState((state) => ({
    servers: [
      {
        id: SID,
        name: "Test",
        host,
        port: 6697,
        isConnected: true,
        users: [],
        channels: [channel()],
        privateChats: [],
        capabilities: [],
      } as Server,
    ],
    messages: {},
    activeBatches: {},
    processedMessageIds: new Set(),
    globalSettings: { ...state.globalSettings, bridgedUsers },
  }));
}

function emit(sender: string, message: string, mtags?: Record<string, string>) {
  ircClient.triggerEvent("CHANMSG", {
    serverId: SID,
    mtags,
    sender,
    channelName: "#general",
    message,
    timestamp: new Date(),
  });
}

const last = () => useStore.getState().messages[KEY]?.at(-1);

describe("bridged users in CHANMSG", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    vi.spyOn(ircClient, "getCurrentUser").mockReturnValue({
      id: "u1",
      username: "me",
    } as never);
    resetBridgeRulesForTests();
    saveOwnBridgeRules(file([LST, IHD]));
    setup("irc.lst.gg");
  });

  afterEach(() => {
    resetBridgeRulesForTests();
    vi.restoreAllMocks();
  });

  test("a matching bot line is stored as the person", () => {
    emit("Bot", "[mara] hi");
    expect(last()).toMatchObject({
      userId: "mara",
      content: "hi",
      bridgedVia: "Bot",
      bridgedOriginal: "[mara] hi",
    });
  });

  test("a bot line that matches no template stays the bot's", () => {
    emit("Bot", "Welcome aboard");
    expect(last()).toMatchObject({ userId: "Bot", content: "Welcome aboard" });
    expect(last()?.bridgedVia).toBeUndefined();
  });

  test("the bot tag does not follow the person", () => {
    emit("Bot", "[mara] hi", { bot: "", msgid: "m1" });
    expect(last()?.tags).toEqual({ msgid: "m1" });
  });

  test("my own nick through the bridge is not a mention", () => {
    emit("Bot", "[me] me: test");
    expect(last()).toMatchObject({
      userId: "me",
      bridgedVia: "Bot",
      mentioned: [],
    });
  });

  test("a mention inside the stripped text still counts", () => {
    emit("Bot", "[mara] me: hi");
    expect(last()?.mentioned).toEqual(["me"]);
  });

  test("the setting off leaves lines untouched", () => {
    setup("irc.lst.gg", false);
    emit("Bot", "[mara] hi");
    expect(last()).toMatchObject({ userId: "Bot", content: "[mara] hi" });
  });

  test("a wrapped nick gets a display nick and keeps its userId", () => {
    setup("irc.infinityhd.net");
    emit("(Jeditwo)", "o/");
    expect(last()).toMatchObject({
      userId: "(Jeditwo)",
      displayNick: "Jeditwo",
      bridgedVia: "web",
      content: "o/",
    });
    expect(last()?.bridgedOriginal).toBeUndefined();
  });
});

describe("upstreamHostForServer", () => {
  test("uses the bouncer network's host for a bound connection", () => {
    const state = {
      servers: [
        {
          id: SID,
          host: "bouncer.example",
          bouncerServerId: "b",
          bouncerNetid: "7",
        } as Server,
        { id: "s2", host: "IRC.Direct.example." } as Server,
      ],
      bouncers: {
        b: {
          networks: { "7": { attributes: { host: "irc.lst.gg" } } },
        },
      },
    } as unknown as Pick<AppState, "servers" | "bouncers">;
    expect(upstreamHostForServer(state, SID)).toBe("irc.lst.gg");
    expect(upstreamHostForServer(state, "s2")).toBe("irc.direct.example");
    expect(upstreamHostForServer(state, "nope")).toBe("");
  });
});
