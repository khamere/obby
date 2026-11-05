import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "zustand";
import { muteChat, resetMutesForTests } from "../../src/lib/mutes";
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
  afterEach(() => resetMutesForTests());

  it("marks mentions of chats muted in an earlier session seen on startup", () => {
    muteChat("s1", "dev", "channel", null);
    const store = createStore<Pick<AppState, "mentionLog">>(() => ({
      mentionLog: [mention("a", "dev"), mention("b", "ops")],
    }));
    registerMuteHandlers(store as never);
    expect(store.getState().mentionLog.map((m) => m.seen)).toEqual([
      true,
      false,
    ]);
    muteChat("s1", "ops", "channel", null);
    expect(store.getState().mentionLog.every((m) => m.seen)).toBe(true);
  });
});
