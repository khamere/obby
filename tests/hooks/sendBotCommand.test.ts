import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendBotCommand } from "../../src/hooks/useMessageSending";
import { base64DecodeUtf8 } from "../../src/lib/base64";
import ircClient from "../../src/lib/ircClient";
import type { BotCommand, Channel } from "../../src/types";

const channel = { id: "c1", name: "#lobby", users: [] } as unknown as Channel;

function sent(sendRaw: ReturnType<typeof vi.spyOn>) {
  return sendRaw.mock.calls.map((call: unknown[]) => {
    const line = call[1] as string;
    const [, b64, , target] =
      line.match(/^@\+draft\/bot-cmd=(\S+) (TAGMSG) (\S+)$/) ?? [];
    return { target, payload: JSON.parse(base64DecodeUtf8(b64)) };
  });
}

describe("sendBotCommand", () => {
  let sendRaw: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
    sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a public+pm command from a channel once, publicly", () => {
    const cmd: BotCommand = { name: "joke", contexts: ["public", "pm"] };
    expect(sendBotCommand("s1", channel, "cve_bot", cmd, {})).toBe(true);
    expect(sent(sendRaw)).toEqual([
      {
        target: "#lobby",
        payload: { name: "joke", options: {}, bot: "cve_bot" },
      },
    ]);
  });

  it("sends a private+pm command from a channel once, to the bot with the channel", () => {
    const cmd: BotCommand = { name: "help", contexts: ["private", "pm"] };
    expect(
      sendBotCommand("s1", channel, "cve_bot", cmd, { topic: "vhost" }),
    ).toBe(true);
    expect(sent(sendRaw)).toEqual([
      {
        target: "cve_bot",
        payload: {
          name: "help",
          options: { topic: "vhost" },
          channel: "#lobby",
        },
      },
    ]);
  });

  it("falls back to pm from a channel when that is the only context", () => {
    const cmd: BotCommand = { name: "status", contexts: ["pm"] };
    expect(sendBotCommand("s1", channel, "cve_bot", cmd, {})).toBe(true);
    expect(sent(sendRaw)).toEqual([
      { target: "cve_bot", payload: { name: "status", options: {} } },
    ]);
  });

  it("sends only the pm form from a DM", () => {
    const cmd: BotCommand = {
      name: "joke",
      contexts: ["public", "private", "pm"],
    };
    expect(sendBotCommand("s1", null, "cve_bot", cmd, {})).toBe(true);
    expect(sent(sendRaw)).toEqual([
      { target: "cve_bot", payload: { name: "joke", options: {} } },
    ]);
  });

  it("refuses a channel-only command from a DM", () => {
    const cmd: BotCommand = { name: "joke", contexts: ["public"] };
    expect(sendBotCommand("s1", null, "cve_bot", cmd, {})).toBe(false);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});
