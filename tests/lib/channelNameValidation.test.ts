import { describe, expect, test } from "vitest";
import { channelFromLink, isJoinableChannelName } from "../../src/lib/ircUtils";

describe("isJoinableChannelName", () => {
  test.each([
    "#lobby",
    "##linux",
    "&local",
    "^voice",
    "$stream",
    "#a:b",
    "#café",
  ])("%s can be joined", (name) =>
    expect(isJoinableChannelName(name)).toBe(true),
  );

  test.each([
    ["a second argument", "#lobby key"],
    ["a channel list", "#lobby,#other"],
    ["the leave-all target", "#lobby,0"],
    ["a line break", "#lobby\r\nPRIVMSG #other :text"],
    ["a NUL", "#lobby\0"],
    ["a tab", "#lob\tby"],
    ["no channel prefix", "lobby"],
    ["only a prefix and a space", "# "],
    ["an empty name", ""],
    ["an overlong name", `#${"a".repeat(200)}`],
  ])("a name with %s cannot be joined", (_, name) =>
    expect(isJoinableChannelName(name)).toBe(false),
  );

  test("the server's CHANTYPES decides the prefix", () => {
    expect(isJoinableChannelName("&local", "#")).toBe(false);
    expect(isJoinableChannelName("#lobby", "#")).toBe(true);
  });
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

  test("ignores a missing parameter", () =>
    expect(channelFromLink(null)).toBeNull());
});
