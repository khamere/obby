import { describe, expect, it } from "vitest";
import { readUnsent } from "../../../src/lib/irc/unsentLines";

describe("reading the lines that never left", () => {
  it("names the chat of each message", () => {
    expect(
      readUnsent([
        "PRIVMSG #c :one",
        "PRIVMSG #c :two",
        "PRIVMSG #c :three",
        "PRIVMSG #D :four",
      ]).map((line) => line.target),
    ).toEqual(["#c", "#c", "#c", "#D"]);
  });

  it("keeps the label of a labelled message", () => {
    expect(readUnsent(["@+reply=abc;label=lr-1 PRIVMSG #c :hi"])[0].label).toBe(
      "lr-1",
    );
    expect(readUnsent(["PRIVMSG #c :hi"])[0].label).toBeUndefined();
  });

  it("names the channel a whisper belongs to", () => {
    expect(
      readUnsent([
        "@+channel-context=#room;+draft/channel-context=#room PRIVMSG bob :psst",
        "@+draft/channel-context=#old PRIVMSG bob :psst",
      ]),
    ).toEqual([
      { target: "bob", context: "#room", label: undefined },
      { target: "bob", context: "#old", label: undefined },
    ]);
  });

  it("counts the messages of a batch and skips the lines that open and close it", () => {
    expect(
      readUnsent([
        "BATCH +b draft/multiline #c",
        "@batch=b PRIVMSG #c :x",
        "BATCH -b",
      ]),
    ).toEqual([{ target: "#c", context: undefined, label: undefined }]);
  });
});
