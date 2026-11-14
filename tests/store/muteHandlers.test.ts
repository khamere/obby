import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand";
import {
  chatMute,
  muteChat,
  resetMutesForTests,
  silencesFor,
} from "../../src/lib/mutes";
import type { AppState } from "../../src/store";
import { registerMuteHandlers } from "../../src/store/handlers/mutes";
import type { MentionEntry } from "../../src/store/mentionLog";

const mention = (msgid: string, channelId: string): MentionEntry => ({
  messageId: `id-${msgid}`,
  msgid,
  serverId: "s1",
  channelId,
  channelName: `#${channelId}`,
  sender: "bob",
  content: `me: ${msgid}`,
  timestamp: new Date().toISOString(),
  seen: false,
});

describe("mute handlers", () => {
  beforeEach(() => resetMutesForTests());
  afterEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    resetMutesForTests();
  });

  it("marks mentions of chats muted in an earlier session seen on startup", () => {
    // No channel is loaded this early: the mention's own channel name has to do.
    muteChat("s1", { kind: "channel", name: "#DEV" }, null);
    const store = createStore<Pick<AppState, "mentionLog" | "servers">>(() => ({
      mentionLog: [mention("a", "dev"), mention("b", "ops")],
      servers: [],
    }));
    registerMuteHandlers(store as never);
    expect(store.getState().mentionLog.map((m) => m.seen)).toEqual([
      true,
      false,
    ]);
    muteChat("s1", { kind: "channel", name: "#ops" }, null);
    expect(store.getState().mentionLog.every((m) => m.seen)).toBe(true);
  });

  it("names a mute stored under a chat id when its channel is loaded", () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === "obby.mutes"
        ? JSON.stringify({
            servers: {},
            chats: { "s1/dev": { until: null, kind: "channel" } },
          })
        : null,
    );
    const store = createStore<Pick<AppState, "mentionLog" | "servers">>(() => ({
      mentionLog: [mention("a", "dev")],
      servers: [],
    }));
    registerMuteHandlers(store as never);
    const unloaded = { id: "s1", channels: [], privateChats: [] };
    expect(store.getState().mentionLog[0].seen).toBe(true);
    expect(silencesFor(unloaded)).toEqual([]);

    store.setState({
      servers: [
        { id: "s1", channels: [{ id: "dev", name: "#dev" }], privateChats: [] },
      ] as never,
    });

    expect(silencesFor(unloaded)).toEqual([{ chat: "#dev", until: null }]);
    expect(chatMute("s1", { kind: "channel", name: "#Dev" })).toBeDefined();
  });
});
