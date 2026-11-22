import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildReplayLines,
  HistoryRecorder,
} from "../../../src/lib/history/historyLines";
import { IRCClient } from "../../../src/lib/irc/IRCClient";
import { parseServerTime } from "../../../src/lib/irc/utils";

const feed = (client: IRCClient, line: string) =>
  (
    client as unknown as {
      handleMessage: (data: string, serverId: string) => void;
    }
  ).handleMessage(`${line}\r\n`, "srv");

afterEach(() => vi.useRealTimers());

describe("receive time", () => {
  test("a line without server-time carries one time for the chat and the saved history", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });
    const client = new IRCClient();
    const onMessage = vi.fn();
    const onParsed = vi.fn();
    client.on("CHANMSG", onMessage);
    client.on("parsedLine", (parsed) => {
      onParsed(parsed);
      vi.advanceTimersByTime(5);
    });

    feed(client, ":alice!a@h PRIVMSG #lobby :hi");
    vi.advanceTimersByTime(5);

    const time = onParsed.mock.calls[0][0].mtags.time;
    expect(time).toBe("2026-10-14T10:00:00.000Z");
    expect(onMessage.mock.calls[0][0].timestamp.toISOString()).toBe(time);
  });

  test("a time on a leap second reaches no handler as a time it cannot read", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });
    const client = new IRCClient();
    const leap = "2012-06-30T23:59:60.419Z";
    const tagTimes: string[] = [];
    const shown: Date[] = [];
    client.on("parsedLine", (parsed) =>
      tagTimes.push(parsed.mtags?.time ?? ""),
    );
    client.on("JOIN", ({ time }) =>
      shown.push(time ? new Date(time) : new Date()),
    );
    client.on("MULTILINE_MESSAGE", ({ timestamp }) => shown.push(timestamp));
    client.on("CHANMSG", ({ timestamp }) => shown.push(timestamp));

    feed(client, `@time=${leap} :alice!a@h JOIN #lobby`);
    feed(
      client,
      `@time=${leap};msgid=m1 :alice!a@h BATCH +ml draft/multiline #lobby`,
    );
    feed(client, "@batch=ml :alice!a@h PRIVMSG #lobby :one");
    feed(client, "@batch=ml :alice!a@h PRIVMSG #lobby :two");
    feed(client, ":alice!a@h BATCH -ml");
    feed(client, `@time=${leap} :alice!a@h PRIVMSG #lobby :hi`);

    expect(tagTimes).toHaveLength(6);
    expect(tagTimes.map((time) => new Date(time).toISOString())).toEqual(
      tagTimes.map(() => "2026-10-14T10:00:00.000Z"),
    );
    expect(shown.map((time) => time.toISOString())).toEqual([
      "2026-10-14T10:00:00.000Z",
      "2026-10-14T10:00:00.000Z",
      "2026-10-14T10:00:00.000Z",
    ]);
    expect(client.hasLineServerTime).toBe(false);
  });

  test.each([
    "2026-10-13T10:00:00.123Z",
    "2026-10-13T10:00:00Z",
    "2026-10-13T10:00:00.5Z",
    "2026-10-13T10:00:00.12Z",
    "2026-10-13T10:00:00.1234Z",
    "2026-10-13T10:00:00.123456Z",
    "2026-10-13T10:00:00.123456789Z",
    "2026-10-13T10:00:00.999999999Z",
    "2024-02-29T23:59:59.999Z",
  ])(
    "a server time of %s reaches the handlers in the one form every reader takes the same way",
    (sent) => {
      vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });
      const client = new IRCClient();
      const onParsed = vi.fn();
      const onMessage = vi.fn();
      client.on("parsedLine", onParsed);
      client.on("CHANMSG", onMessage);

      feed(client, `@time=${sent} :alice!a@h PRIVMSG #lobby :hi`);

      const { mtags, line, hasReceiveTime } = onParsed.mock.calls[0][0];
      expect(hasReceiveTime).toBe(false);
      expect(line).toContain(`time=${sent}`);
      expect(mtags.time).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(mtags.time).toBe(new Date(parseServerTime(sent)).toISOString());
      expect(Date.parse(mtags.time)).toBe(parseServerTime(sent));
      expect(onMessage.mock.calls[0][0].timestamp.getTime()).toBe(
        parseServerTime(sent),
      );
    },
  );

  test("a server-time tag that is no date gives way to the receive time", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });
    const client = new IRCClient();
    const onMessage = vi.fn();
    const onParsed = vi.fn();
    client.on("CHANMSG", onMessage);
    client.on("parsedLine", onParsed);

    feed(
      client,
      "@time=9999-99-99T99:99:99.999Z :alice!a@h PRIVMSG #lobby :hi",
    );

    expect(onParsed.mock.calls[0][0].mtags.time).toBe(
      "2026-10-14T10:00:00.000Z",
    );
    expect(onMessage.mock.calls[0][0].timestamp.toISOString()).toBe(
      "2026-10-14T10:00:00.000Z",
    );
  });

  test("a line says whether its time is the server's or ours", () => {
    const client = new IRCClient();
    const onParsed = vi.fn();
    client.on("parsedLine", onParsed);

    feed(client, "@time=2020-01-01T00:00:00.000Z :alice!a@h PRIVMSG #lobby :1");
    feed(client, "@time=9999-99-99T99:99:99.999Z :alice!a@h PRIVMSG #lobby :2");
    feed(client, ":alice!a@h PRIVMSG #lobby :3");

    expect(
      onParsed.mock.calls.map(([parsed]) => parsed.hasReceiveTime),
    ).toEqual([false, true, true]);
  });

  test.each([
    "3000",
    "2026-11-21",
    "2026-11-21T10:00:00",
    "2026-11-21T10:00:00.000+00:00",
    "9999-12-31T23:59:59.999Z",
  ])("a time tag of %s counts as no server time", (value) => {
    vi.useFakeTimers({ now: Date.parse("2026-11-22T10:00:00.000Z") });
    const client = new IRCClient();
    const onMessage = vi.fn();
    const onParsed = vi.fn();
    client.on("CHANMSG", onMessage);
    client.on("parsedLine", onParsed);

    feed(client, `@time=${value} :alice!a@h PRIVMSG #lobby :hi`);

    expect(client.hasLineServerTime).toBe(false);
    expect(onParsed.mock.calls[0][0]).toMatchObject({
      hasReceiveTime: true,
      mtags: { time: "2026-11-22T10:00:00.000Z" },
    });
    expect(onMessage.mock.calls[0][0].timestamp.toISOString()).toBe(
      "2026-11-22T10:00:00.000Z",
    );
  });

  test("a row saved with a server-time tag that is no date replays at the time of its row on every replay", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });
    const client = new IRCClient();
    const onMessage = vi.fn();
    client.on("CHANMSG", onMessage);
    const legacyRow = {
      time: Date.parse("2026-09-01T08:30:00.000Z"),
      raw: "@time=9999-99-99T99:99:99.999Z;msgid=m1 :alice!a@h PRIVMSG #lobby :hi",
    };

    for (const batchId of ["obby-local-1", "obby-local-2"]) {
      vi.advanceTimersByTime(60_000);
      for (const line of buildReplayLines("#lobby", [legacyRow], batchId))
        feed(client, line);
    }

    expect(
      onMessage.mock.calls.map(([message]) => message.timestamp.toISOString()),
    ).toEqual(["2026-09-01T08:30:00.000Z", "2026-09-01T08:30:00.000Z"]);
  });

  test("a line with two server-time tags shows and replays at one time", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });
    const recorder = new HistoryRecorder("srv", {
      ownNick: () => "me",
      isOpenConversation: () => true,
      hasChathistory: () => false,
      chantypes: () => "#",
      isEncryptedPm: () => false,
      now: () => Date.now(),
    });
    const client = new IRCClient();
    const saved: { raw: string; time: number }[] = [];
    const onMessage = vi.fn();
    client.on("CHANMSG", onMessage);
    client.on("parsedLine", (parsed) => {
      for (const action of recorder.feed(parsed))
        if (action.type === "rows") saved.push(...action.rows);
    });

    feed(
      client,
      "@time=2020-01-01T00:00:00.000Z;msgid=m1;time=nonsense :alice!a@h PRIVMSG #lobby :hi",
    );
    vi.advanceTimersByTime(60_000);
    for (const line of buildReplayLines("#lobby", saved, "obby-local-1"))
      feed(client, line);

    expect(saved.map((row) => new Date(row.time).toISOString())).toEqual([
      "2026-10-14T10:00:00.000Z",
    ]);
    expect(
      onMessage.mock.calls.map(([message]) => message.timestamp.toISOString()),
    ).toEqual(["2026-10-14T10:00:00.000Z", "2026-10-14T10:00:00.000Z"]);
  });

  test("a saved line whose server-time tag is no date replays with the time it arrived", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T10:00:00.000Z") });
    const recorder = new HistoryRecorder("srv", {
      ownNick: () => "me",
      isOpenConversation: () => true,
      hasChathistory: () => false,
      chantypes: () => "#",
      isEncryptedPm: () => false,
      now: () => Date.now(),
    });
    const client = new IRCClient();
    const saved: { raw: string; time: number }[] = [];
    const replayed = vi.fn();
    client.on("parsedLine", (parsed) => {
      if (parsed.command === "PRIVMSG") replayed(parsed.mtags?.time);
      for (const action of recorder.feed(parsed))
        if (action.type === "rows") saved.push(...action.rows);
    });

    feed(
      client,
      "@time=9999-99-99T99:99:99.999Z;msgid=m1 :alice!a@h PRIVMSG #lobby :hi",
    );
    expect(saved).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    for (const line of buildReplayLines("#lobby", saved, "obby-local-1"))
      feed(client, line);

    expect(replayed.mock.calls).toEqual([
      ["2026-10-14T10:00:00.000Z"],
      ["2026-10-14T10:00:00.000Z"],
    ]);
  });
});
