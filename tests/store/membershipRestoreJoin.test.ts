import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { isMembershipRestoreJoin } from "../../src/store/handlers/users";

// A bouncer replays every channel to each new client, and we rejoin cached
// channels on reconnect. Those own-JOINs must not post "joined #chan" lines.
let serverId = "";
let counter = 0;

function seed() {
  serverId = `restore-srv-${++counter}`;
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 6697,
        channels: [
          {
            id: `${serverId}-chan`,
            name: "#lounge",
            isPrivate: false,
            serverId,
            unreadCount: 0,
            isMentioned: false,
            messages: [],
            users: [],
          },
        ],
        privateChats: [],
        isConnected: true,
        users: [],
      },
    ],
    messages: {},
    activeBatches: {},
    globalSettings: { showEvents: true, showJoinsParts: true },
  } as unknown as Partial<AppState>);
  ircClient.nicks.set(serverId, "me");
}

function joinLines(): number {
  return (
    useStore.getState().messages[`${serverId}-${serverId}-chan`] ?? []
  ).filter((m) => m.type === "join").length;
}

function join(username: string) {
  ircClient.triggerEvent("JOIN", {
    serverId,
    username,
    channelName: "#lounge",
  });
}

function register() {
  ircClient.triggerEvent("ready", {
    serverId,
    serverName: "irc.test",
    nickname: "me",
  });
}

describe("own JOINs that only restore membership", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
  });

  test("our JOIN right after registration posts no join line", () => {
    register();
    join("me");
    expect(joinLines()).toBe(0);
  });

  test("another user's JOIN right after registration is still shown", () => {
    register();
    join("bob");
    expect(joinLines()).toBe(1);
  });

  test("our JOIN well after registration (a real /join) is shown", () => {
    register();
    const later = Date.now() + 60_000;
    expect(isMembershipRestoreJoin(serverId, later)).toBe(false);
    vi.spyOn(Date, "now").mockReturnValue(later);
    join("me");
    expect(joinLines()).toBe(1);
  });

  test("without a recorded registration nothing is suppressed", () => {
    expect(isMembershipRestoreJoin(serverId)).toBe(false);
    join("me");
    expect(joinLines()).toBe(1);
  });
});
