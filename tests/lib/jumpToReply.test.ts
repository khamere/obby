import { beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { jumpToMessage, reportJumpFailure } from "../../src/lib/jumpToMessage";
import { jumpToReply, savedReply } from "../../src/lib/jumpToReply";
import useStore from "../../src/store";
import {
  findSavedMessage,
  loadOlderMessages,
} from "../../src/store/handlers/history";
import type { Message, Server } from "../../src/types";

vi.mock("../../src/store/handlers/history", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/store/handlers/history")
  >()),
  findSavedMessage: vi.fn(),
  loadOlderMessages: vi.fn(),
}));
vi.mock("../../src/lib/jumpToMessage", () => ({
  jumpToMessage: vi.fn(),
  reportJumpFailure: vi.fn(),
}));

const serverId = "s1";
const key = `${serverId}-ch-dev`;

const line = (id: string, msgid: string, time: string): Message => ({
  id,
  msgid,
  type: "message",
  content: `text ${id}`,
  timestamp: new Date(time),
  userId: "alice",
  channelId: "ch-dev",
  serverId,
  reactions: [],
  replyMessage: null,
  mentioned: [],
});

describe("jumpToReply", () => {
  beforeEach(() => {
    vi.mocked(findSavedMessage).mockReset();
    vi.mocked(loadOlderMessages).mockReset();
    vi.mocked(jumpToMessage).mockReset();
    vi.mocked(reportJumpFailure).mockReset();
    useStore.setState({
      servers: [
        {
          id: serverId,
          name: "One",
          host: "irc.example",
          port: 6697,
          isConnected: true,
          users: [],
          privateChats: [{ id: "pm-bob", username: "bob" }],
          channels: [
            {
              id: "ch-dev",
              name: "#dev",
              serverId,
              users: [],
              messages: [],
              unreadCount: 0,
              isMentioned: false,
              isPrivate: false,
            },
          ],
        } as unknown as Server,
      ],
      messages: { [key]: [line("m2", "id-2", "2026-10-14T10:02:00Z")] },
    });
    useStore.setState({ revealMessage: vi.fn() } as never);
  });

  it("looks the saved copy up by the conversation's name", async () => {
    vi.mocked(findSavedMessage).mockResolvedValue(null);
    await savedReply(serverId, "pm-bob", "id-x");
    expect(findSavedMessage).toHaveBeenCalledWith(
      useStore,
      serverId,
      "bob",
      "id-x",
    );
  });

  it("shows a loaded original at once", async () => {
    await jumpToReply(serverId, "ch-dev", "id-2");
    expect(useStore.getState().revealMessage).toHaveBeenCalledWith("m2");
    expect(findSavedMessage).not.toHaveBeenCalled();
  });

  it("jumps to a saved original through its saved surroundings", async () => {
    vi.mocked(findSavedMessage).mockResolvedValue({
      nick: "alice",
      text: "old",
      time: 1000,
    });
    vi.mocked(jumpToMessage).mockResolvedValue({ ok: true, messageId: "m0" });
    await jumpToReply(serverId, "ch-dev", "id-0");
    expect(jumpToMessage).toHaveBeenCalledWith({
      serverId,
      target: "#dev",
      time: 1000,
      msgid: "id-0",
      nick: "alice",
      text: "old",
    });
    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it("pages back from the server until the original is loaded", async () => {
    vi.mocked(findSavedMessage).mockResolvedValue(null);
    const pages = [
      line("m1", "id-1", "2026-10-14T10:01:00Z"),
      line("m0", "id-0", "2026-10-14T09:30:00Z"),
    ];
    vi.mocked(loadOlderMessages).mockImplementation(async () => {
      const page = pages.shift();
      if (!page) return false;
      // The page lands after the request, like a server answer does.
      setTimeout(() => {
        useStore.setState((state) => ({
          messages: { [key]: [page, ...state.messages[key]] },
        }));
      }, 0);
      return true;
    });
    await jumpToReply(serverId, "ch-dev", "id-0");
    expect(loadOlderMessages).toHaveBeenCalledTimes(2);
    expect(useStore.getState().revealMessage).toHaveBeenCalledWith("m0");
    expect(reportJumpFailure).not.toHaveBeenCalled();
  });

  it("sees a page that landed before the wait, such as one read from disk", async () => {
    vi.mocked(findSavedMessage).mockResolvedValue(null);
    vi.mocked(loadOlderMessages).mockImplementation(async () => {
      useStore.setState((state) => ({
        messages: {
          [key]: [
            line("m0", "id-0", "2026-10-14T09:30:00Z"),
            ...state.messages[key],
          ],
        },
      }));
      return true;
    });
    await jumpToReply(serverId, "ch-dev", "id-0");
    expect(useStore.getState().revealMessage).toHaveBeenCalledWith("m0");
  }, 2000);

  it("asks the server directly when saved history is unreachable", async () => {
    vi.mocked(findSavedMessage).mockResolvedValue(null);
    vi.mocked(loadOlderMessages).mockRejectedValue(new Error("blocked"));
    const before = vi
      .spyOn(ircClient, "requestChathistoryBefore")
      .mockImplementation(() => {
        setTimeout(() => {
          useStore.setState((state) => ({
            messages: {
              [key]: [
                line("m0", "id-0", "2026-10-14T09:30:00Z"),
                ...state.messages[key],
              ],
            },
          }));
        }, 0);
        return true;
      });
    await jumpToReply(serverId, "ch-dev", "id-0");
    expect(before).toHaveBeenCalledWith(
      serverId,
      "#dev",
      "2026-10-14T10:02:00.000Z",
    );
    expect(useStore.getState().revealMessage).toHaveBeenCalledWith("m0");
    before.mockRestore();
  });

  it("gives up when the server has nothing older", async () => {
    vi.mocked(findSavedMessage).mockResolvedValue(null);
    vi.mocked(loadOlderMessages).mockResolvedValue(false);
    await jumpToReply(serverId, "ch-dev", "id-0");
    expect(reportJumpFailure).toHaveBeenCalledWith(serverId, "not-found");
  });
});
