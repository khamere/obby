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

  it("skips a nick rule whose label would hide the marker, and trims a good one", () => {
    const out = parseBridgeRules(
      file([
        { ...IHD, label: "" },
        { ...IHD, label: "   " },
        { ...IHD, label: "x".repeat(33) },
        { ...IHD, label: "  site  " },
      ]),
    );
    expect(out.skipped).toBe(3);
    expect(out.rules).toEqual([{ ...IHD, label: "site" }]);
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

describe("bridge rules store", () => {
  const LINK = "https://files.example/raw/bridges.json";
  let backing: Map<string, string>;
  let remote: { status: number; body: string };
  let fetchMock: ReturnType<typeof vi.fn>;
  const lstMatches = () =>
    applyBridgeRules(
      getCompiledBridgeRules(),
      "irc.lst.gg",
      "#g",
      "Bot",
      "[a] b",
    )?.kind;

  beforeEach(() => {
    resetBridgeRulesForTests();
    backing = new Map();
    remote = { status: 200, body: file([LST]) };
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
    expect(lstMatches()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a link, applies it, caches it, and own rules win", async () => {
    await setBridgeRulesLink(LINK);
    expect(getBridgeRulesState().linkStatus).toBe("ok");
    expect(getBridgeRulesState().linkRules).toEqual({
      rules: [LST],
      skipped: 0,
    });
    expect(lstMatches()).toBe("bot");
    expect(backing.get("obby.bridgeRules.linkCache")).toBe(file([LST]));

    saveOwnBridgeRules(file([{ ...LST, formats: ["<{nick}> {text}"] }]));
    expect(lstMatches()).toBeUndefined();
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
    expect(lstMatches()).toBe("bot");
    await vi.waitFor(() =>
      expect(getBridgeRulesState().linkStatus).toBe("cached"),
    );
    expect(lstMatches()).toBe("bot");
  });

  it("reports an error for a preview page or a bad file and loads nothing from it", async () => {
    remote.body = "<!doctype html><html>preview</html>";
    await setBridgeRulesLink(LINK);
    expect(getBridgeRulesState().linkStatus).toBe("error");
    expect(lstMatches()).toBeUndefined();
    remote.body = JSON.stringify({ version: 2, rules: [] });
    await setBridgeRulesLink(`${LINK}`);
    expect(getBridgeRulesState().linkStatus).toBe("error");
  });

  it("removing the link clears the cache and the rules", async () => {
    await setBridgeRulesLink(LINK);
    await setBridgeRulesLink("");
    expect(getBridgeRulesState().linkStatus).toBe("none");
    expect(backing.has("obby.bridgeRules.linkCache")).toBe(false);
    expect(lstMatches()).toBeUndefined();
  });

  it("rejects a bad link and bad own JSON", async () => {
    await expect(setBridgeRulesLink("ftp://x")).rejects.toThrow("bad-link");
    expect(() => saveOwnBridgeRules("{nope")).toThrow("bad-json");
    expect(getBridgeRulesState().own).toBe("");
  });
});
