import { describe, expect, it } from "vitest";
import {
  applyTheme,
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  getTheme,
  hexToHsl,
  hexToTriplet,
  resolveTheme,
  THEME_TOKENS,
  validateTheme,
} from "../../src/lib/theme";

function fakeRoot() {
  const vars = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    style: {
      setProperty: (k: string, v: string) => {
        vars.set(k, v);
      },
      removeProperty: (k: string) => {
        vars.delete(k);
      },
    },
    setAttribute: (k: string, v: string) => {
      attrs.set(k, v);
    },
    removeAttribute: (k: string) => {
      attrs.delete(k);
    },
    vars,
    attrs,
  };
}

describe("hexToHsl", () => {
  it("converts to the h s% l% form shadcn variables use", () => {
    expect(hexToHsl("#ff0000")).toBe("0 100% 50%");
    expect(hexToHsl("#ffffff")).toBe("0 0% 100%");
    expect(hexToHsl("#5865f2")).toBe("235 86% 65%");
  });
});

describe("hexToTriplet", () => {
  it("converts #rrggbb and #rgb to an RGB triplet", () => {
    expect(hexToTriplet("#5865F2")).toBe("88 101 242");
    expect(hexToTriplet("#fff")).toBe("255 255 255");
  });
});

describe("built-in themes", () => {
  it("every preset defines every token with a hex colour", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const token of THEME_TOKENS) {
        expect(theme.colors[token], `${theme.id}.${token}`).toMatch(
          /^#[0-9a-f]{6}$/i,
        );
      }
    }
  });

  it("the default preset reproduces the original palette", () => {
    const def = getTheme(DEFAULT_THEME_ID);
    expect(def.colors["bg-base"].toLowerCase()).toBe("#36393f");
    expect(def.colors["bg-sidebar"].toLowerCase()).toBe("#202225");
    expect(def.colors.primary.toLowerCase()).toBe("#5865f2");
    expect(def.colors.fg.toLowerCase()).toBe("#dcddde");
  });

  it("falls back to the default for an unknown id", () => {
    expect(getTheme("nope").id).toBe(DEFAULT_THEME_ID);
  });
});

describe("validateTheme", () => {
  const good = {
    id: "mine",
    name: "Mine",
    appearance: "dark",
    colors: Object.fromEntries(THEME_TOKENS.map((t) => [t, "#123456"])),
  };

  it("accepts a complete theme", () => {
    expect(validateTheme(good)?.name).toBe("Mine");
  });

  it("rejects anything that is not a hex colour", () => {
    expect(
      validateTheme({
        ...good,
        colors: { ...good.colors, fg: "url(https://evil)" },
      }),
    ).toBeNull();
    expect(
      validateTheme({ ...good, colors: { ...good.colors, fg: "red" } }),
    ).toBeNull();
  });

  it("rejects missing tokens, unknown appearance and junk input", () => {
    const { fg: _fg, ...missing } = good.colors;
    expect(validateTheme({ ...good, colors: missing })).toBeNull();
    expect(validateTheme({ ...good, appearance: "neon" })).toBeNull();
    expect(validateTheme("nope")).toBeNull();
    expect(validateTheme(null)).toBeNull();
  });

  it("ignores unknown colour keys and trims the name", () => {
    const v = validateTheme({
      ...good,
      name: "  Mine  ",
      colors: { ...good.colors, "background-image": "#000000" },
    });
    expect(v?.name).toBe("Mine");
    expect(Object.keys(v?.colors ?? {})).toEqual(THEME_TOKENS);
  });
});

describe("applyTheme", () => {
  it("writes every token as a triplet and marks the appearance", () => {
    const root = fakeRoot();
    applyTheme(getTheme("dracula"), "", root as never);
    expect(root.vars.get("--obby-bg-base")).toBe(
      hexToTriplet(getTheme("dracula").colors["bg-base"]),
    );
    expect(root.vars.size).toBe(THEME_TOKENS.length + 2);
    expect(root.vars.get("--primary")).toBe(
      hexToHsl(getTheme("dracula").colors.primary),
    );
    expect(root.attrs.get("data-appearance")).toBe("dark");
    expect(root.attrs.get("data-obby-theme")).toBe("dracula");
  });

  it("an accent override replaces the primary colour only", () => {
    const root = fakeRoot();
    applyTheme(getTheme(DEFAULT_THEME_ID), "#ff0000", root as never);
    expect(root.vars.get("--obby-primary")).toBe("255 0 0");
    expect(root.vars.get("--primary")).toBe("0 100% 50%");
    expect(root.vars.get("--obby-link")).toBe("0 175 244");
  });

  it("ignores an invalid accent override", () => {
    const root = fakeRoot();
    applyTheme(getTheme(DEFAULT_THEME_ID), "red", root as never);
    expect(root.vars.get("--obby-primary")).toBe("88 101 242");
  });
});

describe("resolveTheme", () => {
  const custom = {
    id: "custom",
    name: "Mine",
    appearance: "dark",
    colors: Object.fromEntries(THEME_TOKENS.map((t) => [t, "#010203"])),
  };
  const linked = validateTheme({ ...custom, id: "shared", name: "Shared" });

  it("returns the preset for a preset id", () => {
    expect(resolveTheme({ theme: "nord", customTheme: "" }, null).id).toBe(
      "nord",
    );
  });

  it("returns the stored custom theme when selected and valid", () => {
    expect(
      resolveTheme(
        { theme: "custom", customTheme: JSON.stringify(custom) },
        null,
      ).name,
    ).toBe("Mine");
    expect(
      resolveTheme({ theme: "custom", customTheme: "{bad" }, null).id,
    ).toBe(DEFAULT_THEME_ID);
  });

  it("returns the linked theme when selected, else the default", () => {
    expect(resolveTheme({ theme: "link", customTheme: "" }, linked).id).toBe(
      "shared",
    );
    expect(resolveTheme({ theme: "link", customTheme: "" }, null).id).toBe(
      DEFAULT_THEME_ID,
    );
  });
});
