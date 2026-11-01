import { describe, expect, it } from "vitest";
import {
  applyBridgeRules,
  compileBridgeRules,
  mergeBridgeRules,
  parseBridgeRules,
} from "../../src/lib/bridgeRules";

const file = (rules: unknown[]) => JSON.stringify({ version: 1, rules });
const compiled = (rules: unknown[]) =>
  compileBridgeRules(parseBridgeRules(file(rules)).rules);
const LST = { host: "irc.lst.gg", bot: "Bot", formats: ["[{nick}] {text}"] };
const RFX = {
  host: "irc.reelflix.cc",
  bot: "WALL-E",
  formats: ["[Chatbox] {nick}: {text}"],
};
const IHD = {
  host: "irc.infinityhd.net",
  nickFormat: "({nick})",
  label: "web",
};

describe("parseBridgeRules", () => {
  it("parses good rules and counts skipped ones", () => {
    const out = parseBridgeRules(
      file([
        LST,
        { host: "x" },
        { host: "y", bot: "b", formats: ["{text}"] },
        { ...LST, nickFormat: "({nick})" },
      ]),
    );
    expect(out.rules).toEqual([LST]);
    expect(out.skipped).toBe(3);
  });

  it("rejects the whole file when it is not usable", () => {
    expect(() => parseBridgeRules("<!doctype html>")).toThrow("bad-json");
    expect(() =>
      parseBridgeRules(JSON.stringify({ version: 2, rules: [] })),
    ).toThrow("bad-version");
    expect(() =>
      parseBridgeRules(file(Array.from({ length: 501 }, () => LST))),
    ).toThrow("too-many-rules");
    expect(() => parseBridgeRules("x".repeat(1_000_001))).toThrow("too-large");
  });
});

describe("mergeBridgeRules", () => {
  it("lets an own rule replace the linked one for the same host and bot", () => {
    const own = { ...LST, formats: ["<{nick}> {text}"] };
    expect(mergeBridgeRules([LST, RFX], [own])).toEqual([RFX, own]);
  });
});

describe("applyBridgeRules", () => {
  const rules = compiled([
    LST,
    RFX,
    IHD,
    {
      host: "irc.nebulance.io",
      bot: "Sauron",
      channels: ["#ant"],
      formats: ["[SB] {nick}: {text}"],
    },
  ]);

  it("rewrites a bot line on the right network", () => {
    expect(
      applyBridgeRules(rules, "irc.lst.gg", "#general", "Bot", "[mara] hi"),
    ).toEqual({ kind: "bot", nick: "mara", text: "hi", via: "Bot" });
  });

  it("ignores case and mode prefixes on the sender and host", () => {
    expect(
      applyBridgeRules(rules, "IRC.LST.GG", "#general", "@bot", "[mara] hi")
        ?.kind,
    ).toBe("bot");
  });

  it("matches through IRC colour codes", () => {
    expect(
      applyBridgeRules(
        rules,
        "irc.reelflix.cc",
        "#general",
        "WALL-E",
        "\x0304[Chatbox]\x03 4SURE: hi",
      ),
    ).toEqual({ kind: "bot", nick: "4SURE", text: "hi", via: "WALL-E" });
  });

  it("returns null for another network, another nick, a non-matching line, or the wrong channel", () => {
    expect(
      applyBridgeRules(rules, "irc.znth.cx", "#general", "Bot", "[mara] hi"),
    ).toBeNull();
    expect(
      applyBridgeRules(rules, "irc.lst.gg", "#general", "alice", "[mara] hi"),
    ).toBeNull();
    expect(
      applyBridgeRules(
        rules,
        "irc.lst.gg",
        "#general",
        "Bot",
        "Welcome aboard",
      ),
    ).toBeNull();
    expect(
      applyBridgeRules(
        rules,
        "irc.nebulance.io",
        "#other",
        "Sauron",
        "[SB] x: hi",
      ),
    ).toBeNull();
    expect(
      applyBridgeRules(
        rules,
        "irc.nebulance.io",
        "#ANT",
        "Sauron",
        "[SB] x: hi",
      )?.kind,
    ).toBe("bot");
  });

  it("unwraps a wrapped nick without touching the text", () => {
    expect(
      applyBridgeRules(
        rules,
        "irc.infinityhd.net",
        "#infinityhd",
        "(Jeditwo)",
        "o/ all",
      ),
    ).toEqual({ kind: "nick", displayNick: "Jeditwo", via: "web" });
    expect(
      applyBridgeRules(
        rules,
        "irc.infinityhd.net",
        "#infinityhd",
        "Jeditwo",
        "o/",
      ),
    ).toBeNull();
  });
});
