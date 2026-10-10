import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";

// MOTD numerics used to be dropped entirely; they now land as one notice in
// the server's notices view, keeping each line verbatim.
const serverId = "motd-srv";

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

function notices() {
  return useStore.getState().messages[`${serverId}-server-notices`] ?? [];
}

describe("MOTD", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    useStore.setState({
      servers: [
        {
          id: serverId,
          name: "test",
          host: "irc.test",
          port: 6697,
          channels: [],
          privateChats: [],
          isConnected: true,
          users: [],
        },
      ],
      messages: {},
    } as unknown as Partial<AppState>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a full MOTD becomes one notice with its lines intact", () => {
    feed(
      ":irc.test 375 me :- irc.test Message of the Day -",
      ":irc.test 372 me :-   _  _",
      ":irc.test 372 me :-  | || |  welcome",
      ":irc.test 372 me :- ",
      ":irc.test 372 me :- \x0304red\x03 rules",
      ":irc.test 376 me :End of /MOTD command.",
    );
    expect(notices()).toHaveLength(1);
    const [motd] = notices();
    expect(motd.type).toBe("notice");
    expect(motd.userId).toBe("irc.test");
    expect(motd.motdLines).toEqual([
      "  _  _",
      " | || |  welcome",
      "",
      "\x0304red\x03 rules",
    ]);
  });

  test("ERR_NOMOTD shows the server's explanation as a plain notice", () => {
    feed(":soju.test 422 me :Use /motd to read the message of the day");
    const [notice] = notices();
    expect(notice.content).toBe("Use /motd to read the message of the day");
    expect(notice.motdLines).toBeUndefined();
  });

  test("lines without RPL_MOTDSTART are still collected", () => {
    feed(":irc.test 372 me :- only line", ":irc.test 376 me :End");
    expect(notices()[0].motdLines).toEqual(["only line"]);
  });

  test("a MOTD for an unknown server is ignored", () => {
    (
      ircClient as unknown as {
        handleMessage(data: string, serverId: string): void;
      }
    ).handleMessage(":x 375 me :-\r\n:x 376 me :End", "nope");
    expect(useStore.getState().messages["nope-server-notices"]).toBeUndefined();
  });
});
