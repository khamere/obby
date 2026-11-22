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
