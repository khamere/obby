import { describe, expect, it } from "vitest";
import {
  APP_COMMAND_NAMES,
  CLIENT_COMMAND_NAMES,
  clientCommandUsage,
  getClientCommands,
  isAppCommand,
  isNickWord,
  typedAppCommand,
} from "../../src/lib/clientCommands";

describe("the client command list", () => {
  const names = getClientCommands().map((c) => c.name);

  it("lists exactly the names the client owns", () => {
    expect(new Set(names)).toEqual(new Set(CLIENT_COMMAND_NAMES));
    expect(names).toHaveLength(CLIENT_COMMAND_NAMES.size);
    for (const name of APP_COMMAND_NAMES)
      expect(CLIENT_COMMAND_NAMES.has(name)).toBe(true);
  });

  it("ends with the app commands", () => {
    expect(names.slice(-7)).toEqual([
      "query",
      "whois",
      "ignore",
      "unignore",
      "list",
      "close",
      "raw",
    ]);
  });

  it("describes close by what it closes", () => {
    const close = (inChannel: boolean) =>
      getClientCommands(inChannel).find((c) => c.name === "close")?.description;
    expect(close(true)).toBe("Leave channel");
    expect(close(false)).toBe("Close conversation");
  });
});

describe("typedAppCommand", () => {
  it("reads the name in any case and keeps the rest as typed", () => {
    expect(typedAppCommand("/close")).toEqual({
      name: "close",
      argumentText: "",
    });
    expect(typedAppCommand("/CLOSE ")?.name).toBe("close");
    expect(typedAppCommand("/raw  PRIVMSG #a :x  y")).toEqual({
      name: "raw",
      argumentText: "  PRIVMSG #a :x  y",
    });
    expect(typedAppCommand("/raw\nQUIT")).toEqual({
      name: "raw",
      argumentText: "\nQUIT",
    });
  });

  it.each(["/closet", "//close", "close", "/list@helpbot", "/me waves", ""])(
    "leaves %j to the other handlers",
    (text) => {
      expect(typedAppCommand(text)).toBeNull();
      expect(isAppCommand(text)).toBe(false);
    },
  );
});

describe("clientCommandUsage", () => {
  it.each([
    ["query", "/query <user>"],
    ["ignore", "/ignore [user]"],
    ["close", "/close"],
    ["raw", "/raw <line>"],
  ])("writes %s as %s", (name, usage) => {
    expect(clientCommandUsage(name)).toBe(usage);
  });
});

describe("isNickWord", () => {
  it.each(["alice", "[w]olf-9", "relay/net"])("takes %j", (word) => {
    expect(isNickWord(word)).toBe(true);
  });

  it.each(["", "a,b", "nick!u@h", "u@h", "tro*", "x?", ":x"])(
    "refuses %j",
    (word) => {
      expect(isNickWord(word)).toBe(false);
    },
  );

  it("takes wildcards for the ignore list, and still no list or mask", () => {
    expect(isNickWord("tro*", true)).toBe(true);
    expect(isNickWord("x?", true)).toBe(true);
    expect(isNickWord("a,b", true)).toBe(false);
    expect(isNickWord("nick!u@h", true)).toBe(false);
  });
});
