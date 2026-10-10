import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageSending } from "../../src/hooks/useMessageSending";
import { getClientCommands, slapAction } from "../../src/lib/clientCommands";
import ircClient from "../../src/lib/ircClient";
import type { Channel, User } from "../../src/types";

describe("slapAction", () => {
  it("is the classic trout slap", () => {
    expect(slapAction(["bob"])).toBe(
      "slaps bob around a bit with a large trout",
    );
  });

  it("takes a custom item", () => {
    expect(slapAction(["bob", "a", "wet", "noodle"])).toBe(
      "slaps bob around a bit with a wet noodle",
    );
  });

  it("needs someone to slap", () => {
    expect(slapAction([])).toBeNull();
    expect(slapAction(["", ""])).toBeNull();
  });

  it("is listed for the slash-command popover", () => {
    expect(getClientCommands().some((c) => c.name === "slap")).toBe(true);
  });
});

describe("/slap", () => {
  const channel = {
    id: "c1",
    name: "#lounge",
    isPrivate: false,
    serverId: "s1",
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users: [],
  } as Channel;
  const me = { id: "me", username: "me", isOnline: true } as User;

  function send(text: string) {
    const { result } = renderHook(() =>
      useMessageSending({
        selectedServerId: "s1",
        selectedChannelId: channel.id,
        selectedPrivateChatId: null,
        selectedChannel: channel,
        selectedPrivateChat: null,
        currentUser: me,
        selectedColor: null,
        selectedFormatting: [],
        localReplyTo: null,
      }),
    );
    result.current.sendMessage(text);
  }

  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a CTCP ACTION to the current channel", () => {
    send("/slap bob");
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "s1",
      "PRIVMSG #lounge :\u0001ACTION slaps bob around a bit with a large trout\u0001",
    );
  });

  it("sends nothing without a target", () => {
    send("/slap");
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });
});
