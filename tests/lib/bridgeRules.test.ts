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
const ALDER = { host: "irc.alder.example", bot: "Bot", formats: ["[{nick}] {text}"] };
const CINDER = {
  host: "irc.cinder.example",
  bot: "ChatRelay",
  formats: ["[Chatbox] {nick}: {text}"],
};
const LANTERN = {
  host: "irc.lantern.example",
  nickFormat: "({nick})",
  label: "web",
};

describe("parseBridgeRules", () => {
  it("parses good rules and counts skipped ones", () => {
    const out = parseBridgeRules(
      file([
        ALDER,
        { host: "x" },
        { host: "y", bot: "b", formats: ["{text}"] },
        { ...ALDER, nickFormat: "({nick})" },
      ]),
    );
    expect(out.rules).toEqual([ALDER]);
    expect(out.skipped).toBe(3);
  });

  it("rejects the whole file when it is not usable", () => {
    expect(() => parseBridgeRules("<!doctype html>")).toThrow("bad-json");
    expect(() =>
      parseBridgeRules(JSON.stringify({ version: 2, rules: [] })),
    ).toThrow("bad-version");
    expect(() =>
      parseBridgeRules(file(Array.from({ length: 501 }, () => ALDER))),
    ).toThrow("too-many-rules");
    expect(() => parseBridgeRules("x".repeat(1_000_001))).toThrow("too-large");
  });
});

describe("mergeBridgeRules", () => {
  it("lets an own rule replace the linked one for the same host and bot", () => {
    const own = { ...ALDER, formats: ["<{nick}> {text}"] };
    expect(mergeBridgeRules([ALDER, CINDER], [own])).toEqual([CINDER, own]);
  });
});

describe("applyBridgeRules", () => {
  const rules = compiled([
    ALDER,
    CINDER,
    LANTERN,
    {
      host: "irc.meadow.example",
      bot: "ShoutRelay",
      channels: ["#meadow"],
      formats: ["[SB] {nick}: {text}"],
    },
  ]);

  it("rewrites a bot line on the right network", () => {
    expect(
      applyBridgeRules(rules, "irc.alder.example", "#general", "Bot", "[mara] hi"),
    ).toEqual({ kind: "bot", nick: "mara", text: "hi", via: "Bot" });
  });

  it("ignores case and mode prefixes on the sender and host", () => {
    expect(
      applyBridgeRules(rules, "IRC.ALDER.EXAMPLE", "#general", "@bot", "[mara] hi")
        ?.kind,
    ).toBe("bot");
  });

  it("matches through IRC colour codes", () => {
    expect(
      applyBridgeRules(
        rules,
        "irc.cinder.example",
        "#general",
        "ChatRelay",
        "\x0304[Chatbox]\x03 7Nova: hi",
      ),
    ).toEqual({ kind: "bot", nick: "7Nova", text: "hi", via: "ChatRelay" });
  });

  it("returns null for another network, another nick, a non-matching line, or the wrong channel", () => {
    expect(
      applyBridgeRules(rules, "irc.zephyr.example", "#general", "Bot", "[mara] hi"),
    ).toBeNull();
    expect(
      applyBridgeRules(rules, "irc.alder.example", "#general", "alice", "[mara] hi"),
    ).toBeNull();
    expect(
      applyBridgeRules(
        rules,
        "irc.alder.example",
        "#general",
        "Bot",
        "Welcome aboard",
      ),
    ).toBeNull();
    expect(
      applyBridgeRules(
        rules,
        "irc.meadow.example",
        "#other",
        "ShoutRelay",
        "[SB] x: hi",
      ),
    ).toBeNull();
    expect(
      applyBridgeRules(
        rules,
        "irc.meadow.example",
        "#MEADOW",
        "ShoutRelay",
        "[SB] x: hi",
      )?.kind,
    ).toBe("bot");
  });

  it("unwraps a wrapped nick without touching the text", () => {
    expect(
      applyBridgeRules(
        rules,
        "irc.lantern.example",
        "#lantern",
        "(Tobias)",
        "o/ all",
      ),
    ).toEqual({ kind: "nick", displayNick: "Tobias", via: "web" });
    expect(
      applyBridgeRules(
        rules,
        "irc.lantern.example",
        "#lantern",
        "Tobias",
        "o/",
      ),
    ).toBeNull();
  });
});
