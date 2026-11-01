import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBridgeRules,
  compileBridgeRules,
  getBridgeRulesState,
  getCompiledBridgeRules,
  loadBridgeRules,
  mergeBridgeRules,
  parseBridgeRules,
  resetBridgeRulesForTests,
  saveOwnBridgeRules,
  setBridgeRulesLink,
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

  it("skips a nick rule whose label would hide the marker, and trims a good one", () => {
    const out = parseBridgeRules(
      file([
        { ...LANTERN, label: "" },
        { ...LANTERN, label: "   " },
        { ...LANTERN, label: "x".repeat(33) },
        { ...LANTERN, label: "  site  " },
      ]),
    );
    expect(out.skipped).toBe(3);
    expect(out.rules).toEqual([{ ...LANTERN, label: "site" }]);
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

describe("bridge rules store", () => {
  const LINK = "https://files.example/raw/bridges.json";
  let backing: Map<string, string>;
  let remote: { status: number; body: string };
  let fetchMock: ReturnType<typeof vi.fn>;
  const alderMatches = () =>
    applyBridgeRules(
      getCompiledBridgeRules(),
      "irc.alder.example",
      "#g",
      "Bot",
      "[a] b",
    )?.kind;

  beforeEach(() => {
    resetBridgeRulesForTests();
    backing = new Map();
    remote = { status: 200, body: file([ALDER]) };
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((k) => {
      backing.delete(k);
    });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(LINK);
      expect(init).toMatchObject({
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-cache",
      });
      return new Response(remote.body, { status: remote.status });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    resetBridgeRulesForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts empty and fetches nothing", () => {
    loadBridgeRules();
    expect(getBridgeRulesState().linkStatus).toBe("none");
    expect(alderMatches()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a link, applies it, caches it, and own rules win", async () => {
    await setBridgeRulesLink(LINK);
    expect(getBridgeRulesState().linkStatus).toBe("ok");
    expect(getBridgeRulesState().linkRules).toEqual({
      rules: [ALDER],
      skipped: 0,
    });
    expect(alderMatches()).toBe("bot");
    expect(backing.get("obby.bridgeRules.linkCache")).toBe(file([ALDER]));

    saveOwnBridgeRules(file([{ ...ALDER, formats: ["<{nick}> {text}"] }]));
    expect(alderMatches()).toBeUndefined();
    expect(getBridgeRulesState().ownRules.rules).toHaveLength(1);

    resetBridgeRulesForTests();
    loadBridgeRules();
    expect(getBridgeRulesState().ownRules.rules).toHaveLength(1);
    expect(getBridgeRulesState().linkStatus).toBe("cached");
  });

  it("keeps the cached copy when the host is down", async () => {
    await setBridgeRulesLink(LINK);
    remote.status = 503;
    resetBridgeRulesForTests();
    loadBridgeRules();
    expect(alderMatches()).toBe("bot");
    await vi.waitFor(() =>
      expect(getBridgeRulesState().linkStatus).toBe("cached"),
    );
    expect(alderMatches()).toBe("bot");
  });

  it("reports an error for a preview page or a bad file and loads nothing from it", async () => {
    remote.body = "<!doctype html><html>preview</html>";
    await setBridgeRulesLink(LINK);
    expect(getBridgeRulesState().linkStatus).toBe("error");
    expect(alderMatches()).toBeUndefined();
    remote.body = JSON.stringify({ version: 2, rules: [] });
    await setBridgeRulesLink(`${LINK}`);
    expect(getBridgeRulesState().linkStatus).toBe("error");
  });

  it("removing the link clears the cache and the rules", async () => {
    await setBridgeRulesLink(LINK);
    await setBridgeRulesLink("");
    expect(getBridgeRulesState().linkStatus).toBe("none");
    expect(backing.has("obby.bridgeRules.linkCache")).toBe(false);
    expect(alderMatches()).toBeUndefined();
  });

  it("rejects a bad link and bad own JSON", async () => {
    await expect(setBridgeRulesLink("ftp://x")).rejects.toThrow("bad-link");
    expect(() => saveOwnBridgeRules("{nope")).toThrow("bad-json");
    expect(getBridgeRulesState().own).toBe("");
  });
});
