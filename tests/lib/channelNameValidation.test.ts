import { describe, expect, test } from "vitest";
import {
  breaksJoinLine,
  cannotBeChannelName,
  channelFromLink,
  isJoinableChannelKey,
  isJoinableChannelName,
} from "../../src/lib/ircUtils";

describe("isJoinableChannelName", () => {
  test.each([
    "#lobby",
    "##linux",
    "&local",
    "^voice",
    "$stream",
    "#a:b",
    "#café",
    "#日本語",
    "#two\u00a0words",
    "#lob\tby",
    `#${"a".repeat(300)}`,
  ])("%s can be joined", (name) =>
    expect(isJoinableChannelName(name)).toBe(true),
  );

  test.each([
    ["a second argument", "#lobby key"],
    ["a channel list", "#lobby,#other"],
    ["the leave-all target", "#lobby,0"],
    ["a line break", "#lobby\r\nPRIVMSG #other :text"],
    ["a NUL", "#lobby\0"],
    ["a BEL", "#lob\x07by"],
    ["no channel prefix", "lobby"],
    ["only a prefix and a space", "# "],
    ["an empty name", ""],
  ])("a name with %s cannot be joined", (_, name) =>
    expect(isJoinableChannelName(name)).toBe(false),
  );

  test("the server's CHANTYPES decides the prefix", () => {
    expect(isJoinableChannelName("&local", "#")).toBe(false);
    expect(isJoinableChannelName("#lobby", "#")).toBe(true);
  });
});

describe("breaksJoinLine", () => {
  test.each(["#a b", "#a,#b", "#a\0", "#a\rb", "#a\nb"])(
    "%j changes the line",
    (name) => expect(breaksJoinLine(name)).toBe(true),
  );

  test.each([
    "#two\u00a0words",
    "#lob\tby",
    "#lob\x07by",
    `#${"a".repeat(300)}`,
    "lobby",
  ])("%j leaves the line whole", (name) =>
    expect(breaksJoinLine(name)).toBe(false),
  );
});

describe("cannotBeChannelName", () => {
  test.each(["#a b", "#a,#b", "#a\nb", "#lob\x07by"])(
    "%j is a name no server holds",
    (name) => expect(cannotBeChannelName(name)).toBe(true),
  );

  test.each(["#two\u00a0words", "#lob\tby", `#${"a".repeat(300)}`, "#café"])(
    "%j is for the server to judge",
    (name) => expect(cannotBeChannelName(name)).toBe(false),
  );
});

describe("isJoinableChannelKey", () => {
  test.each(["secret", "pässword", "a:b", "two words", ":secret", " x "])(
    "%j is one key",
    (key) => expect(isJoinableChannelKey(key)).toBe(true),
  );

  test.each(["one,two", "key\r\nQUIT", "key\nQUIT", "key\0"])(
    "%j is more than one key",
    (key) => expect(isJoinableChannelKey(key)).toBe(false),
  );
});

describe("channelFromLink", () => {
  test("keeps a channel name as given", () =>
    expect(channelFromLink("#weather")).toBe("#weather"));

  test("gives a bare name the # prefix", () =>
    expect(channelFromLink(" weather ")).toBe("#weather"));

  test.each(["#x\r\nPRIVMSG #chan :text", "#a,0", "#a key", "a b", "", "   "])(
    "ignores %j",
    (raw) => expect(channelFromLink(raw)).toBeNull(),
  );

  test.each(["#café", "#two\u00a0words", `#${"a".repeat(300)}`])(
    "leaves %j for the server to judge",
    (raw) => expect(channelFromLink(raw)).toBe(raw),
  );

  test("ignores a missing parameter", () =>
    expect(channelFromLink(null)).toBeNull());
});
