import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appendRows,
  newestEventRows,
  whenHistoryIdle,
} from "../../src/lib/history/historyDb";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

const serverId = "rename-history-srv";

beforeEach(() => {
  ircClient.nicks.set(serverId, "me");
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 6697,
        channels: [{ id: "c-lounge", name: "#Lounge", users: [] }],
        privateChats: [],
        isConnected: true,
        users: [],
      } as unknown as Server,
    ],
    messages: {},
    mentionLog: [],
  });
});
afterEach(() => {
  ircClient.nicks.delete(serverId);
});

test("the saved history of a renamed channel is read back under its new name", async () => {
  await appendRows([
    {
      server: serverId,
      target: "#lounge",
      time: 1000,
      key: "a",
      msgid: "a",
      raw: "@msgid=a;time=1970-01-01T00:00:01.000Z :op!u@h PRIVMSG #Lounge :hello",
    },
  ]);

  (
    ircClient as unknown as {
      handleMessage: (data: string, serverId: string) => void;
    }
  ).handleMessage(":op!u@h RENAME #lounge #den\r\n", serverId);
  await whenHistoryIdle();

  expect(await newestEventRows(serverId, "#lounge", 10)).toEqual([]);
  const rows = await newestEventRows(serverId, "#den", 10);
  expect(rows.map((row) => row.raw)).toEqual([
    "@msgid=a;time=1970-01-01T00:00:01.000Z :op!u@h PRIVMSG #den :hello",
  ]);
});

const feed = (line: string) =>
  (
    ircClient as unknown as {
      handleMessage: (data: string, serverId: string) => void;
    }
  ).handleMessage(`${line}\r\n`, serverId);

const savedLine = (target: string, key: string) => ({
  server: serverId,
  target: target.toLowerCase(),
  time: 1000,
  key,
  msgid: key,
  raw: `@msgid=${key};time=1970-01-01T00:00:01.000Z :op!u@h PRIVMSG ${target} :hello`,
});
const targetsOf = async (...names: string[]) =>
  Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        (await newestEventRows(serverId, name, 10)).map((row) => row.key),
      ]),
    ),
  );

test.each([
  [
    "arrives in a history page",
    [
      ":irc.test BATCH +h1 chathistory #h-b",
      "@batch=h1 :op!u@h RENAME #h-a #h-b",
      ":irc.test BATCH -h1",
    ],
  ],
  ["names a channel we hold no row for", [":op!u@h RENAME #h-ghost #h-a"]],
  ["leads to another channel we are in", [":op!u@h RENAME #h-a #h-b"]],
])(
  "the saved history stays where it is when a rename %s",
  async (_case, lines) => {
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        channels: [
          { id: "c-a", name: "#h-a", users: [] },
          { id: "c-b", name: "#h-b", users: [] },
        ] as unknown as Server["channels"],
      })),
    }));
    await appendRows([
      savedLine("#h-a", "a1"),
      savedLine("#h-b", "b1"),
      savedLine("#h-ghost", "g1"),
    ]);

    for (const line of lines) feed(line);
    await whenHistoryIdle();

    expect(await targetsOf("#h-a", "#h-b", "#h-ghost")).toEqual({
      "#h-a": ["a1"],
      "#h-b": ["b1"],
      "#h-ghost": ["g1"],
    });
  },
);

test("a renamed channel keeps its saved history apart from what a left channel of the new name saved", async () => {
  useStore.setState((state) => ({
    servers: state.servers.map((s) => ({
      ...s,
      channels: [
        { id: "c-k", name: "#k-old", users: [] },
        { id: "c-n", name: "#k-new", users: [], leftReason: "parted" },
      ] as unknown as Server["channels"],
    })),
  }));
  await appendRows([savedLine("#k-old", "o1"), savedLine("#k-new", "n1")]);

  feed(":op!u@h RENAME #k-old #k-new");
  await whenHistoryIdle();

  expect(
    useStore.getState().servers[0].channels.map((c) => [c.id, c.name]),
  ).toEqual([["c-k", "#k-new"]]);
  expect(await targetsOf("#k-old", "#k-new")).toEqual({
    "#k-old": ["o1"],
    "#k-new": ["n1"],
  });
});
