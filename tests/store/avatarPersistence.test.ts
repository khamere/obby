import { beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { readyProcessedServers } from "../../src/store/handlers/connection";
import * as storage from "../../src/store/localStorage";
import { bufferWhoReply } from "../../src/store/whoReplyBatcher";
import type { Channel, User } from "../../src/types";

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "chan-1",
    name: "#lobby",
    isPrivate: false,
    serverId: "srv-1",
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users: [],
    ...overrides,
  };
}

describe("avatar persistence across refresh and reconnect", () => {
  beforeEach(() => {
    readyProcessedServers.clear();
    useStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "TestServer",
          host: "irc.example.com",
          port: 6667,
          channels: [makeChannel()],
          privateChats: [],
          isConnected: true,
          capabilities: ["draft/metadata-2"],
          users: [],
        },
      ],
      currentUser: {
        id: "me",
        username: "Me",
        realname: "Myself",
        isOnline: true,
        metadata: {},
      } as User,
      messages: {},
      activeBatches: {},
      globalSettings: {
        showEvents: true,
        showJoinsParts: true,
      },
    } as unknown as AppState);
  });

  it("restores own avatar on connect and publishes METADATA * SET", () => {
    const avatarUrl = "https://cdn.example.com/my-pic.png";
    // Simulate own avatar stored in localStorage from a previous session
    storage.ownMetadata.saveKey("srv-1", "me", "avatar", avatarUrl, "public");

    vi.spyOn(ircClient, "getNick").mockReturnValue("Me");
    vi.spyOn(ircClient, "getCurrentUser").mockReturnValue({
      id: "me",
      username: "Me",
      isOnline: true,
    } as User);
    const metadataSetSpy = vi.spyOn(useStore.getState(), "metadataSet");

    // Trigger ready event (simulates 001 welcome on page reload)
    ircClient.triggerEvent("ready", {
      serverId: "srv-1",
      serverName: "TestServer",
      nickname: "Me",
    });

    const state = useStore.getState();
    expect(state.currentUser?.metadata?.avatar?.value).toBe(avatarUrl);
    expect(metadataSetSpy).toHaveBeenCalledWith(
      "srv-1",
      "*",
      "avatar",
      avatarUrl,
      "public",
    );
  });

  it("preserves avatar when WHO reply batches arrive after reconnect", () => {
    vi.useFakeTimers();
    try {
      const avatarUrl = "https://cdn.example.com/my-pic.png";
      storage.ownMetadata.saveKey("srv-1", "me", "avatar", avatarUrl, "public");

      bufferWhoReply(useStore, "srv-1", "#lobby", {
        nick: "Me",
        host: "user@host",
        realname: "Myself",
      });
      vi.advanceTimersByTime(70);

      const chan = useStore.getState().servers[0].channels[0];
      const member = chan.users.find((u) => u.username.toLowerCase() === "me");
      expect(member).toBeDefined();
      expect(member?.metadata?.avatar?.value).toBe(avatarUrl);
    } finally {
      vi.useRealTimers();
    }
  });
});
