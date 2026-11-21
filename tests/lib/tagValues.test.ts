import { describe, expect, it } from "vitest";
import { escapeTagValue, parseMessageTags } from "../../src/lib/ircUtils";

describe("escapeTagValue", () => {
  it.each([
    "👍",
    "a b",
    "a;b",
    "back\\slash",
    "line\r\nbreak",
    "x PRIVMSG #chan :text ;+reply=1",
    "\\s",
    "trailing\\",
  ])("round-trips %j through the tag parser", (value) => {
    const escaped = escapeTagValue(value);

    expect(escaped).not.toMatch(/[ ;\r\n]/);
    expect(parseMessageTags(`@+tag=${escaped}`)).toEqual({ "+tag": value });
  });
});
