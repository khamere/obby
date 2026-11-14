import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => ({ fn: vi.fn(async () => true) }));
vi.mock("../../src/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/notifications")>()),
  showChatNotification: shown.fn,
}));

import ircClient from "../../src/lib/ircClient";
import {
  type ChatRef,
  chatMute,
  isSilenced,
  muteChat,
  resetMutesForTests,
  silencesFor,
  unmuteChat,
} from "../../src/lib/mutes";
import { pushContextFor } from "../../src/lib/webpush";
import useStore from "../../src/store";
import { generateDeterministicId } from "../../src/store/helpers";
import type { Server } from "../../src/types";

const serverId = "s1";

function seed() {
  ircClient.nicks.set(serverId, "me");
  (
    ircClient as unknown as { currentUsers: Map<string, unknown> }
  ).currentUsers.set(serverId, { id: "me", username: "me", isOnline: true });
  const server = {
    id: serverId,
    name: "Example",
    host: "irc.example.org",
    port: 6697,
    isConnected: true,
    users: [],
    channels: [],
    privateChats: [],
    capabilities: ["draft/chathistory"],
  } as unknown as Server;
  ircClient.servers.set(serverId, { ...server } as never);
  useStore.setState((state) => ({
    servers: [server],
    messages: {},
    activeBatches: {},
    processedMessageIds: new Set(),
    globalSettings: {
      ...state.globalSettings,
      enableNotifications: true,
      notificationVolume: 0.5,
    },
  }));
}

function feed(line: string) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(line, serverId);
}

const server = () => useStore.getState().servers[0];
const dm = (name: string) =>
  server().privateChats.find(
    (pc) => pc.username.toLowerCase() === name.toLowerCase(),
  );
// The chat as the header hands it to the mute dialog.
const ref = (name: string): ChatRef => {
  const chat = dm(name);
  if (!chat) throw new Error(`no private chat with ${name}`);
  return { id: chat.id, kind: "dm", name: chat.username };
};
// A fresh app process: no chats until the server names them, and the mutes
// read from storage again.
function restartApp() {
  resetMutesForTests();
  seed();
}

describe("a muted chat that is created again", () => {
  let backing: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    resetMutesForTests();
    backing = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
    seed();
    shown.fn.mockClear();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetMutesForTests();
    ircClient.nicks.delete(serverId);
    ircClient.servers.delete(serverId);
  });

  it("notifies for a DM that is not muted", () => {
    feed(":Mara!u@h PRIVMSG me :hi");
    expect(shown.fn).toHaveBeenCalledTimes(1);
  });

  it("stays silent after the DM is closed and the person writes again", () => {
    // Opened by a name typed in lower case; the first message corrects the
    // name and leaves the id alone.
    useStore.getState().openPrivateChat(serverId, "mara");
    feed(":Mara!u@h PRIVMSG me :first");
    const first = ref("mara");
    expect(first.name).toBe("Mara");
    muteChat(serverId, first, null);
    useStore.getState().deletePrivateChat(serverId, first.id ?? "");
    shown.fn.mockClear();

    feed(":Mara!u@h PRIVMSG me :are you there?");

    const again = ref("mara");
    expect(again.id).not.toBe(first.id);
    expect(shown.fn).not.toHaveBeenCalled();
    // The bell and the mute dialog show the new chat as muted.
    expect(chatMute(serverId, again.id ?? "")?.until).toBeNull();
    expect(chatMute(serverId, again)?.until).toBeNull();
  });

  it("stays silent after a restart restores the DM under a casefolded name", () => {
    feed(":Mara!u@h PRIVMSG me :hi");
    const live = ref("Mara");
    muteChat(serverId, live, null);

    restartApp();
    feed(":irc.example.org CHATHISTORY TARGETS mara 2026-01-14T18:14:42.492Z");
    vi.runOnlyPendingTimers();
    const restored = ref("mara");
    expect(restored.id).not.toBe(live.id);
    expect(isSilenced(serverId, restored.id, true)).toBe(true);
    shown.fn.mockClear();

    feed(":Mara!u@h PRIVMSG me :hello again");

    expect(shown.fn).not.toHaveBeenCalled();
    expect(silencesFor(server()).map((s) => s.chat.toLowerCase())).toEqual([
      "mara",
    ]);
  });

  it("hands a closed DM's mute to the background side", () => {
    feed(":mara!u@h PRIVMSG me :hi");
    const chat = ref("mara");
    muteChat(serverId, chat, null);
    useStore.getState().deletePrivateChat(serverId, chat.id ?? "");
    expect(silencesFor(server())).toEqual([{ chat: "mara", until: null }]);
  });

  it("hands a channel's mute to the push side before the channel is joined", () => {
    muteChat(serverId, { kind: "channel", name: "#general" }, null);
    restartApp();
    const context = pushContextFor(server(), {
      customMentions: [],
      ignoreList: [],
    });
    expect(context.silenced).toEqual([{ chat: "#general", until: null }]);
  });

  it("follows the person through a nick change, across a restart", () => {
    feed(":mara!u@h PRIVMSG me :hi");
    muteChat(serverId, ref("mara"), null);
    feed(":mara!u@h NICK mara_afk");
    expect(silencesFor(server())).toEqual([{ chat: "mara_afk", until: null }]);
    shown.fn.mockClear();
    feed(":mara_afk!u@h PRIVMSG me :in session");
    expect(shown.fn).not.toHaveBeenCalled();

    restartApp();
    shown.fn.mockClear();
    feed(":mara_afk!u@h PRIVMSG me :after restart");
    expect(shown.fn).not.toHaveBeenCalled();
    expect(chatMute(serverId, ref("mara_afk"))).toBeDefined();
  });

  it.each(["showEvents", "showNickChanges"] as const)(
    "renames the open DM and keeps it muted with %s off",
    (flag) => {
      useStore.setState((state) => ({
        globalSettings: {
          ...state.globalSettings,
          showEvents: true,
          showNickChanges: true,
          [flag]: false,
        },
      }));
      feed(":mara!u@h PRIVMSG me :hi");
      const before = ref("mara");
      muteChat(serverId, before, null);
      const key = `${serverId}-${before.id}`;
      const lines = useStore.getState().messages[key]?.length;

      feed(":mara!u@h NICK mara_afk");

      // The header and the bell look the chat up by its id.
      expect(dm("mara")).toBeUndefined();
      expect(ref("mara_afk").id).toBe(before.id);
      expect(chatMute(serverId, before.id ?? "")?.until).toBeNull();
      expect(useStore.getState().messages[key]?.length).toBe(lines);
      shown.fn.mockClear();
      feed(":mara_afk!u@h PRIVMSG me :still here");
      expect(shown.fn).not.toHaveBeenCalled();
      expect(server().privateChats).toHaveLength(1);
    },
  );

  it("still tells of the nick change in the DM when those events are shown", () => {
    useStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        showEvents: true,
        showNickChanges: true,
      },
    }));
    feed(":mara!u@h PRIVMSG me :hi");
    const chat = ref("mara");
    feed(":mara!u@h NICK mara_afk");
    expect(ref("mara_afk").id).toBe(chat.id);
    const lines = useStore.getState().messages[`${serverId}-${chat.id}`] ?? [];
    expect(lines.at(-1)?.type).toBe("nick");
  });

  it("keeps a channel muted when the channel is renamed", () => {
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        channels: [
          { id: "c-general", name: "#general", users: [] },
        ] as unknown as Server["channels"],
      })),
    }));
    muteChat(
      serverId,
      { id: "c-general", kind: "channel", name: "#general" },
      null,
    );

    feed(":bob!u@h RENAME #General #lounge :tidying up");

    const channel = server().channels[0];
    expect(channel).toMatchObject({ id: "c-general", name: "#lounge" });
    expect(isSilenced(serverId, "c-general", true)).toBe(true);
    expect(silencesFor(server())).toEqual([{ chat: "#lounge", until: null }]);

    restartApp();
    expect(silencesFor(server())).toEqual([{ chat: "#lounge", until: null }]);
  });

  it("notifies again once the recreated chat is unmuted", () => {
    feed(":Mara!u@h PRIVMSG me :hi");
    const live = ref("Mara");
    muteChat(serverId, live, null);
    useStore.getState().deletePrivateChat(serverId, live.id ?? "");
    useStore.getState().openPrivateChat(serverId, "mara");
    unmuteChat(serverId, ref("mara"));
    shown.fn.mockClear();

    feed(":Mara!u@h PRIVMSG me :hello");

    expect(shown.fn).toHaveBeenCalledTimes(1);
    expect(silencesFor(server())).toEqual([]);
  });

  it("names a mute stored under a chat id once that chat is loaded", () => {
    const oldId = generateDeterministicId(serverId, "mara");
    backing.set(
      "obby.mutes",
      JSON.stringify({
        servers: {},
        chats: { [`${serverId}/${oldId}`]: { until: null, kind: "dm" } },
      }),
    );
    restartApp();
    // Nothing is loaded: the entry is kept as it is.
    expect(isSilenced(serverId, oldId, true)).toBe(true);
    expect(silencesFor(server())).toEqual([]);

    feed(":Mara!u@h PRIVMSG me :hi");

    expect(shown.fn).not.toHaveBeenCalled();
    expect(silencesFor(server())).toEqual([{ chat: "Mara", until: null }]);
    expect(JSON.parse(backing.get("obby.mutes") ?? "{}").chats).toEqual({
      [`${serverId}/dm:mara`]: { until: null, kind: "dm", name: "Mara" },
    });
  });
});
