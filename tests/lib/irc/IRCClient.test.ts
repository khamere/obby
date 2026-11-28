import { beforeEach, describe, expect, it, vi } from "vitest";
import { IRCClient } from "../../../src/lib/irc/IRCClient";

describe("IRCClient line safety", () => {
  let client: IRCClient;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new IRCClient();
    send = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: give the client an open socket without connecting
    (client as any).sockets.set("s1", { readyState: WebSocket.OPEN, send });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    ["LF", "PRIVMSG #c :hi\nNICK pwned"],
    ["CR", "PRIVMSG #c :hi\rNICK pwned"],
    ["NUL", "PRIVMSG #c :hi\0"],
  ])("drops a line that carries %s", (_, line) => {
    client.sendRaw("s1", line);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a single line", () => {
    client.sendRaw("s1", "PRIVMSG #c :hi");
    expect(send).toHaveBeenCalledWith("PRIVMSG #c :hi");
  });

  it("sends a multi-line whisper as one PRIVMSG per line", () => {
    client.sendWhisper("s1", "bob", "#c", "one\r\n\ntwo");
    expect(send.mock.calls).toEqual([
      ["@+channel-context=#c;+draft/channel-context=#c PRIVMSG bob :one"],
      ["@+channel-context=#c;+draft/channel-context=#c PRIVMSG bob :two"],
    ]);
  });

  it("sends a whisper longer than a line in parts that each carry the tags", () => {
    const text = "aé漢\u{1F600}\u{1F600}".repeat(45);
    const prefix =
      "@+channel-context=#c;+draft/channel-context=#c PRIVMSG bob :";

    client.sendWhisper("s1", "bob", "#c", text);

    const lines: string[] = send.mock.calls.map(([line]) => line);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith(prefix)).toBe(true);
      // A line to bob carries 380 bytes, and the tags have a budget of their own.
      expect(
        new TextEncoder().encode(line.slice(prefix.length)).length,
      ).toBeLessThanOrEqual(380);
    }
    expect(lines.map((line) => line.slice(prefix.length)).join("")).toBe(text);
  });

  it("ends a part before a character that would cross the limit", () => {
    // A line to bob carries 380 bytes.
    client.sendPrivmsgLines(
      "s1",
      "bob",
      `${"a".repeat(379)}\u{1F600}b`,
      "@label=x ",
    );
    expect(send.mock.calls).toEqual([
      [`@label=x PRIVMSG bob :${"a".repeat(379)}`],
      ["@label=x PRIVMSG bob :\u{1F600}b"],
    ]);
  });

  it("opens the style of a long whisper in every part", () => {
    const prefix =
      "@+channel-context=#c;+draft/channel-context=#c PRIVMSG bob :";

    client.sendWhisper(
      "s1",
      "bob",
      "#c",
      `\x0304\x02${"word ".repeat(150).trim()}\x02`,
    );

    const lines: string[] = send.mock.calls.map(([line]) => line);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith(`${prefix}\x0304\x02word`)).toBe(true);
      // A line to bob carries 380 bytes.
      expect(
        new TextEncoder().encode(line.slice(prefix.length)).length,
      ).toBeLessThanOrEqual(380);
    }
  });

  it.each([
    ["empty text", ""],
    ["a leading line break", "\nhi"],
  ])("sends no empty PRIVMSG for %s", (_, text) => {
    client.sendPrivmsgLines("s1", "bob", text);
    expect(send.mock.calls).toEqual(text ? [["PRIVMSG bob :hi"]] : []);
  });

  it("joins the lines of a topic into one", () => {
    client.setTopic("s1", "#c", "one\ntwo");
    expect(send.mock.calls).toEqual([["TOPIC #c :one two"]]);
  });

  it("reads a bare LF in a frame as the end of a line", () => {
    // biome-ignore lint/suspicious/noExplicitAny: feed one frame to the parser
    (client as any).handleMessage(":srv PING :a\n:srv PING :b", "s1");
    expect(send.mock.calls).toEqual([["PONG :a"], ["PONG :b"]]);
  });
});
