import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageSending } from "../../src/hooks/useMessageSending";
import {
  CLIENT_COMMAND_NAMES,
  getClientCommands,
} from "../../src/lib/clientCommands";
import ircClient from "../../src/lib/ircClient";
import { stripIrcFormatting } from "../../src/lib/messageFormatter";
import { calculateProtocolOverhead } from "../../src/lib/messageProtocol";
import { rainbowText, splitRainbowMessage } from "../../src/lib/rainbow";
import useStore from "../../src/store";
import { routeOutgoingPM } from "../../src/store/handlers/e2eeOutbound";
import type {
  Channel,
  Message,
  PrivateChat,
  Server,
  User,
} from "../../src/types";

vi.mock("../../src/store/handlers/e2eeOutbound", () => ({
  routeOutgoingPM: vi.fn(),
}));

describe("rainbow text", () => {
  it("cycles the seven colors and ends with a reset", () => {
    expect(rainbowText("abcdefgh")).toBe(
      "\x0304a\x0307b\x0308c\x0309d\x0311e\x0312f\x0306g\x0304h\x0f",
    );
  });
  it("preserves spaces, digits, commas, combining accents and emoji", () => {
    const text = "a  12,34 e\u0301 👩🏽‍💻\nnext";
    const result = rainbowText(text);
    expect(stripIrcFormatting(result)).toBe(text);
    expect(result).toContain("e\u0301");
    expect(result).toContain("👩🏽‍💻");
  });
  it("removes pasted formatting and unsafe protocol controls", () => {
    expect(
      stripIrcFormatting(rainbowText("\x02Hi\x02\x0304!\x01\0\r\nthere")),
    ).toBe("Hi!\nthere");
    expect(rainbowText(" \n ")).toBe("");
  });
  it("splits UTF-8 text without cutting colors, emoji or spaces", () => {
    const text = "👩🏽‍💻,123 こんにちは  ".repeat(100);
    const formatted = rainbowText(text);
    const chunks = splitRainbowMessage(formatted, "#chat");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(formatted);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(
        512 - calculateProtocolOverhead("#chat"),
      );
      // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC protocol formatting codes
      expect(chunk).not.toMatch(/\x03\d?$/);
      expect(stripIrcFormatting(chunk)).not.toContain("\ufffd");
    }
  });
  it("bounds long whitespace and pathological combining sequences", () => {
    for (const text of [`a${" ".repeat(1000)}b`, `a${"\u0301".repeat(1000)}`]) {
      const chunks = splitRainbowMessage(rainbowText(text), "#chat");
      expect(chunks.map(stripIrcFormatting).join("")).toBe(text);
      expect(
        chunks.every(
          (c) =>
            new TextEncoder().encode(c).length <=
            512 - calculateProtocolOverhead("#chat"),
        ),
      ).toBe(true);
    }
  });
});

describe("/rainbow", () => {
  const channel = {
    id: "c1",
    name: "#chat",
    serverId: "s1",
    users: [],
    messages: [],
  } as unknown as Channel;
  const peer = {
    id: "p1",
    username: "friend",
    serverId: "s1",
    messages: [],
  } as unknown as PrivateChat;
  const me = { id: "me", username: "me", isOnline: true } as User;
  function send(
    text: string,
    privateChat = false,
    reply: Message | null = null,
  ) {
    const { result } = renderHook(() =>
      useMessageSending({
        selectedServerId: "s1",
        selectedChannelId: privateChat ? null : channel.id,
        selectedPrivateChatId: privateChat ? peer.id : null,
        selectedChannel: privateChat ? null : channel,
        selectedPrivateChat: privateChat ? peer : null,
        currentUser: me,
        selectedColor: null,
        selectedFormatting: [],
        localReplyTo: reply,
      }),
    );
    return result.current.sendMessage(text);
  }
  const initialServers = useStore.getState().servers;
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    vi.spyOn(ircClient, "hasCapability").mockReturnValue(false);
    vi.mocked(routeOutgoingPM).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ servers: initialServers });
  });
  it("is discoverable in command suggestions", () => {
    expect(CLIENT_COMMAND_NAMES.has("rainbow")).toBe(true);
    expect(
      getClientCommands().find((c) => c.name === "rainbow")?.options?.[0]
        .required,
    ).toBe(true);
  });
  it("sends a colored channel message, accepting uppercase commands", () => {
    send("/RAINBOW Hello!");
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "s1",
      `PRIVMSG #chat :${rainbowText("Hello!")}`,
    );
  });
  it("does nothing for an empty argument", () => {
    send("/rainbow");
    send("/rainbow   ");
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });
  it("treats slash-prefixed rainbow text as text, not another command", () => {
    send("/rainbow /join #elsewhere");
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "s1",
      `PRIVMSG #chat :${rainbowText("/join #elsewhere")}`,
    );
  });
  it("passes colored DMs through the encryption route", () => {
    vi.mocked(routeOutgoingPM).mockReturnValue("sent");
    send("/rainbow Secret", true);
    expect(routeOutgoingPM).toHaveBeenCalledWith(
      "s1",
      "friend",
      rainbowText("Secret"),
      undefined,
    );
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });
  it("preserves the draft if encryption withholds the DM", () => {
    vi.mocked(routeOutgoingPM).mockReturnValue("withheld");
    expect(send("/rainbow Secret", true)).toBe("withheld");
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });
  it("routes unencrypted DMs to the selected peer", () => {
    send("/rainbow Hi", true);
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "s1",
      `PRIVMSG friend :${rainbowText("Hi")}`,
    );
  });
  it("sends long rainbow text as intact bounded messages", () => {
    const text = "👩🏽‍💻".repeat(200);
    send(`/rainbow ${text}`);
    const bodies = vi
      .mocked(ircClient.sendRaw)
      .mock.calls.map(([, line]) => line.split(" :")[1]);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map(stripIrcFormatting).join("")).toBe(text);
    expect(
      bodies.every(
        (b) =>
          new TextEncoder().encode(b).length <=
          512 - calculateProtocolOverhead("#chat"),
      ),
    ).toBe(true);
  });
  it("preserves reply tags", () => {
    send("/rainbow Hello", false, { msgid: "parent" } as Message);
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "s1",
      `@+reply=parent;+draft/reply=parent PRIVMSG #chat :${rainbowText("Hello")}`,
    );
  });
  it("keeps whisper replies private and splits long text", () => {
    vi.spyOn(ircClient, "sendWhisper").mockImplementation(() => {});
    const text = "🌈".repeat(200);
    send(`/rainbow ${text}`, false, {
      userId: "friend",
      tags: { "+draft/channel-context": "#chat" },
    } as unknown as Message);
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
    const calls = vi.mocked(ircClient.sendWhisper).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(
      calls.every(
        ([server, target, channel]) =>
          server === "s1" && target === "friend" && channel === "#chat",
      ),
    ).toBe(true);
    expect(calls.map(([, , , text]) => stripIrcFormatting(text)).join("")).toBe(
      text,
    );
  });
  it("preserves multiline batch text and spaces", () => {
    useStore.setState({
      servers: [{ id: "s1", capabilities: ["draft/multiline"] } as Server],
    });
    vi.spyOn(ircClient, "sendMultiline").mockImplementation(() => {});
    const text = `Hello  there\n${"🌈 ".repeat(200)}`;
    send(`/rainbow ${text}`);
    const [server, target, lines] = vi.mocked(ircClient.sendMultiline).mock
      .calls[0];
    expect(server).toBe("s1");
    expect(target).toBe("#chat");
    expect(
      lines.map((chunks) => stripIrcFormatting(chunks.join(""))).join("\n"),
    ).toBe(text);
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });
});
