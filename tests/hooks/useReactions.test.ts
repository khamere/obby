import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReactions } from "../../src/hooks/useReactions";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Message } from "../../src/types";

vi.mock("../../src/lib/ircClient", () => ({
  default: { sendRaw: vi.fn(), on: vi.fn() },
}));

const message: Message = {
  id: "m1",
  msgid: "abc",
  type: "message",
  content: "hi",
  timestamp: new Date(),
  userId: "alice",
  channelId: "chan1",
  serverId: "s1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
};

describe("useReactions", () => {
  // Every message row receives these callbacks, so a new identity re-renders the whole chat.
  it("keeps the row callbacks while the store and the user change", () => {
    const { result, rerender } = renderHook(
      ({ name }) =>
        useReactions({
          selectedServerId: "s1",
          currentUser: { id: "u", username: name } as never,
        }),
      { initialProps: { name: "tester" } },
    );
    const { directReaction, unreact, openReactionModal } = result.current;

    act(() => useStore.setState({ servers: [], messages: {} }));
    rerender({ name: "tester2" });

    expect(result.current.directReaction).toBe(directReaction);
    expect(result.current.unreact).toBe(unreact);
    expect(result.current.openReactionModal).toBe(openReactionModal);
  });

  it("reacts as the current user after a nick change", () => {
    useStore.setState({
      servers: [
        {
          id: "s1",
          channels: [{ id: "chan1", name: "#a", users: [] }],
          privateChats: [],
        },
      ] as never,
      messages: { "s1-chan1": [message] },
    });
    const { result, rerender } = renderHook(
      ({ name }) =>
        useReactions({
          selectedServerId: "s1",
          currentUser: { id: "u", username: name } as never,
        }),
      { initialProps: { name: "tester" } },
    );
    rerender({ name: "renamed" });

    act(() => result.current.directReaction("👍", message));

    expect(useStore.getState().messages["s1-chan1"][0].reactions).toEqual([
      { emoji: "👍", userId: "renamed" },
    ]);
  });

  // The reaction keeps the spelling of the nick it was made under.
  it("removes our reaction from the picker after the nick changed case", () => {
    const stored = {
      ...message,
      reactions: [{ emoji: "👍", userId: "Tester" }],
    };
    useStore.setState({
      servers: [
        {
          id: "s1",
          channels: [{ id: "chan1", name: "#a", users: [] }],
          privateChats: [],
        },
      ] as never,
      messages: { "s1-chan1": [stored] },
    });
    vi.mocked(ircClient.sendRaw).mockClear();
    const { result } = renderHook(() =>
      useReactions({
        selectedServerId: "s1",
        currentUser: { id: "u", username: "tester" } as never,
      }),
    );

    act(() => result.current.openReactionModal(stored));
    act(() => result.current.selectReaction("👍"));

    expect(ircClient.sendRaw).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "@+draft/unreact=👍;+reply=abc;+draft/reply=abc TAGMSG #a",
    );
    expect(useStore.getState().messages["s1-chan1"][0].reactions).toEqual([]);
  });

  describe("a reaction text sent by another client", () => {
    const hostile = "x PRIVMSG #a :injected ;k=v\r\nQUIT";
    const escaped = "x\\sPRIVMSG\\s#a\\s:injected\\s\\:k=v\\r\\nQUIT";
    const target: Message = { ...message, msgid: "id 1;x" };
    const escapedId = "id\\s1\\:x";

    const setup = (reactions: Message["reactions"] = []) => {
      const stored = { ...target, reactions };
      useStore.setState({
        servers: [
          {
            id: "s1",
            channels: [{ id: "chan1", name: "#a", users: [] }],
            privateChats: [],
          },
        ] as never,
        messages: { "s1-chan1": [stored] },
      });
      const { result } = renderHook(() =>
        useReactions({
          selectedServerId: "s1",
          currentUser: { id: "u", username: "tester" } as never,
        }),
      );
      return { result, stored };
    };

    beforeEach(() => vi.mocked(ircClient.sendRaw).mockClear());

    it("stays inside the tag when we add the same reaction", () => {
      const { result, stored } = setup();

      act(() => result.current.directReaction(hostile, stored));

      expect(ircClient.sendRaw).toHaveBeenCalledExactlyOnceWith(
        "s1",
        `@+draft/react=${escaped};+reply=${escapedId};+draft/reply=${escapedId} TAGMSG #a`,
      );
    });

    it("stays inside the tag when we remove our reaction", () => {
      const { result, stored } = setup();

      act(() => result.current.unreact(hostile, stored));

      expect(ircClient.sendRaw).toHaveBeenCalledExactlyOnceWith(
        "s1",
        `@+draft/unreact=${escaped};+reply=${escapedId};+draft/reply=${escapedId} TAGMSG #a`,
      );
    });

    it.each([
      ["add", [], "+draft/react"],
      ["remove", [{ emoji: hostile, userId: "tester" }], "+draft/unreact"],
    ])(
      "stays inside the tag when we %s it from the picker",
      (_, reactions, tag) => {
        const { result, stored } = setup(reactions);

        act(() => result.current.openReactionModal(stored));
        act(() => result.current.selectReaction(hostile));

        expect(ircClient.sendRaw).toHaveBeenCalledExactlyOnceWith(
          "s1",
          `@${tag}=${escaped};+reply=${escapedId};+draft/reply=${escapedId} TAGMSG #a`,
        );
      },
    );
  });

  it("keeps a msgid with a line break inside its tag", () => {
    const hostile = { ...message, msgid: "x\nNICK pwned" };
    useStore.setState({
      servers: [
        {
          id: "s1",
          channels: [{ id: "chan1", name: "#a", users: [] }],
          privateChats: [],
        },
      ] as never,
      messages: { "s1-chan1": [hostile] },
    });
    const sendRaw = vi.mocked(ircClient.sendRaw);
    sendRaw.mockClear();
    const { result } = renderHook(() =>
      useReactions({
        selectedServerId: "s1",
        currentUser: { id: "u", username: "me" } as never,
      }),
    );

    act(() => result.current.directReaction("a b", hostile));
    act(() => result.current.unreact("a b", hostile));

    expect(sendRaw.mock.calls).toEqual([
      [
        "s1",
        "@+draft/react=a\\sb;+reply=x\\nNICK\\spwned;+draft/reply=x\\nNICK\\spwned TAGMSG #a",
      ],
      [
        "s1",
        "@+draft/unreact=a\\sb;+reply=x\\nNICK\\spwned;+draft/reply=x\\nNICK\\spwned TAGMSG #a",
      ],
    ]);
  });
});
