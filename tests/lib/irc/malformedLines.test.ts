import { afterEach, describe, expect, test, vi } from "vitest";
import { IRCClient } from "../../../src/lib/irc/IRCClient";
import { getTimestampFromTags } from "../../../src/lib/irc/utils";

const feed = (client: IRCClient, frame: string) =>
  (
    client as unknown as {
      handleMessage: (data: string, serverId: string) => void;
    }
  ).handleMessage(frame, "srv");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("malformed server lines", () => {
  test("a line whose handling throws leaves the rest of the frame to be handled", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const client = new IRCClient();
    const texts: string[] = [];
    client.on("CHANMSG", ({ message }) => {
      if (message === "first") throw new Error("listener failed");
      texts.push(message);
    });

    feed(
      client,
      ":alice!a@h PRIVMSG #lobby :first\r\n:alice!a@h PRIVMSG #lobby :second\r\n",
    );

    expect(texts).toEqual(["second"]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test("a line whose handling throws still reaches the saved history", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new IRCClient();
    const onParsed = vi.fn();
    client.on("CHANMSG", () => {
      throw new Error("listener failed");
    });
    client.on("parsedLine", onParsed);

    feed(client, ":alice!a@h PRIVMSG #lobby :first\r\n");

    expect(onParsed).toHaveBeenCalledTimes(1);
  });

  test("a JOIN without a channel is skipped and the next line is handled", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new IRCClient();
    const onMessage = vi.fn();
    client.on("CHANMSG", onMessage);

    feed(client, ":alice!a@h JOIN\r\n:alice!a@h PRIVMSG #lobby :hi\r\n");

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  test("a KICK that names nobody is dropped", () => {
    const client = new IRCClient();
    const onKick = vi.fn();
    client.on("KICK", onKick);

    feed(client, ":op!o@h KICK #lobby\r\n");
    feed(client, ":op!o@h KICK\r\n");

    expect(onKick).not.toHaveBeenCalled();
  });

  test("a KICK with a target and a reason is passed on", () => {
    const client = new IRCClient();
    const onKick = vi.fn();
    client.on("KICK", onKick);

    feed(client, ":op!o@h KICK #lobby bob :too loud\r\n");

    expect(onKick.mock.calls[0][0]).toMatchObject({
      username: "op",
      channelName: "#lobby",
      target: "bob",
      reason: "too loud",
    });
  });

  test("a time tag that is no date reads as the current time", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });

    expect(
      getTimestampFromTags({ time: "9999-99-99T99:99:99.999Z" }).toISOString(),
    ).toBe("2026-10-14T10:00:00.000Z");
    expect(
      getTimestampFromTags({ time: "2020-01-01T00:00:00.000Z" }).toISOString(),
    ).toBe("2020-01-01T00:00:00.000Z");
  });
});
