import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatArea } from "../../src/components/layout/ChatArea";
import ircClient from "../../src/lib/ircClient";
import { parseMessageTags } from "../../src/lib/ircUtils";
import {
  setUserFilehost,
  uploadToUserFilehost,
} from "../../src/lib/userFilehost";
import useStore from "../../src/store";
import type { Channel, Message, Server } from "../../src/types";
import { defaultUIExtensions } from "../fixtures/uiState";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const link = "https://files.example/u/note.txt";

vi.mock("../../src/lib/userFilehost", async (original) => ({
  ...(await original<typeof import("../../src/lib/userFilehost")>()),
  uploadToUserFilehost: vi.fn(async () => link),
}));

const channel = {
  id: "channel1",
  name: "#general",
  isPrivate: false,
  serverId: "server1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
} as Channel;

const server = {
  id: "server1",
  name: "Test Server",
  host: "irc.test.com",
  port: 6667,
  channels: [channel],
  privateChats: [],
  isConnected: true,
  users: [],
} as Server;

const replied = {
  id: "m1",
  msgid: "id;1 x",
  type: "message",
  content: "the message we answer",
  timestamp: new Date(),
  userId: "alice",
  channelId: "channel1",
  serverId: "server1",
  reactions: [],
  replyMessage: null,
  mentioned: [],
} as Message;

// The link exists only once the host has answered, so the caption and the link
// leave together after the upload, on a path of their own.
describe("a file sent from the composer", () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
    setUserFilehost({ url: "https://files.example", token: "" });
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_, line) => {
      if (!/^@\+typing=\S+ TAGMSG /.test(line)) sent.push(line);
    });
    useStore.setState((state) => ({
      servers: [server],
      currentUser: { id: "user1", username: "tester", isOnline: true },
      messages: { "server1-channel1": [replied] },
      typingUsers: {},
      ui: {
        ...state.ui,
        ...defaultUIExtensions,
        selectedServerId: "server1",
        perServerSelections: {
          server1: {
            selectedChannelId: "channel1",
            selectedPrivateChatId: null,
          },
        },
      },
    }));
  });

  afterEach(() => {
    setUserFilehost({ url: "", token: "" });
    vi.restoreAllMocks();
  });

  async function sendFile(caption: string, capabilities: string[]) {
    vi.spyOn(ircClient, "hasCapability").mockImplementation((_, cap) =>
      capabilities.includes(cap),
    );
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    const input = screen.getByPlaceholderText(/Message #general/i);
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(["hello"], "note.txt", { type: "text/plain" })],
      },
    });
    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    fireEvent.change(input, { target: { value: caption } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  }

  const replyTags = (line: string) =>
    parseMessageTags(line.slice(0, line.indexOf(" ")));
  const answersTheMessage = { "+reply": "id;1 x", "+draft/reply": "id;1 x" };

  it("posts a one-line caption and the link as one tagged message", async () => {
    await sendFile("see this", []);

    expect(sent).toHaveLength(1);
    expect(replyTags(sent[0])).toEqual(answersTheMessage);
    expect(sent[0].endsWith(` PRIVMSG #general :see this ${link}`)).toBe(true);
  });

  it("posts every line of a caption and the link in one batch", async () => {
    await sendFile("see this\nand that", ["draft/multiline"]);

    expect(sent).toHaveLength(4);
    const batch = /BATCH \+(\S+) draft\/multiline #general$/.exec(sent[0])?.[1];
    expect(replyTags(sent[0])).toEqual(answersTheMessage);
    expect(sent.slice(1)).toEqual([
      `@batch=${batch} PRIVMSG #general :see this`,
      `@batch=${batch} PRIVMSG #general :and that ${link}`,
      `BATCH -${batch}`,
    ]);
  });

  it("posts every line of a caption and the link without batches", async () => {
    useStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        autoFallbackToSingleLine: false,
      },
    }));

    await sendFile("see this\nand that", []);

    expect(sent.map((line) => line.slice(line.indexOf(" ") + 1))).toEqual([
      "PRIVMSG #general :see this",
      `PRIVMSG #general :and that ${link}`,
    ]);
    for (const line of sent) expect(replyTags(line)).toEqual(answersTheMessage);
    useStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        autoFallbackToSingleLine: true,
      },
    }));
  });

  it("runs a typed command on its text alone and keeps the file attached", () => {
    vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
    vi.mocked(uploadToUserFilehost).mockClear();
    render(<ChatArea onToggleChanList={() => {}} isChanListVisible={true} />);
    const input = screen.getByPlaceholderText(/Message #general/i);
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(["hello"], "note.txt", { type: "text/plain" })],
      },
    });
    fireEvent.change(input, { target: { value: "/raw PING x" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(sent).toEqual(["PING x"]);
    expect(uploadToUserFilehost).not.toHaveBeenCalled();
    expect(screen.getByTestId("attachment-tray")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });
});
