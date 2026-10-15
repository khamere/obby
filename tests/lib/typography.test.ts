import { describe, expect, it } from "vitest";
import {
  applyTypography,
  DEFAULT_TYPOGRAPHY,
  resolveFontFamily,
} from "../../src/lib/typography";

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

describe("resolveFontFamily", () => {
  it("maps presets to font stacks", () => {
    expect(resolveFontFamily("roboto-mono", "")).toBe(
      "'Roboto Mono', monospace",
    );
    expect(resolveFontFamily("system-sans", "")).toMatch(/system-ui/);
    expect(resolveFontFamily("system-mono", "")).toMatch(/ui-monospace/);
    expect(resolveFontFamily("system-serif", "")).toMatch(/Georgia|serif/);
  });

  it("quotes a custom family name and keeps a generic fallback", () => {
    expect(resolveFontFamily("custom", "JetBrains Mono")).toBe(
      "'JetBrains Mono', monospace",
    );
  });

  it("falls back to the default when the custom name is empty or unsafe", () => {
    expect(resolveFontFamily("custom", "   ")).toBe("'Roboto Mono', monospace");
    expect(resolveFontFamily("custom", "x'); @import url(evil)")).toBe(
      "'Roboto Mono', monospace",
    );
  });
});

describe("applyTypography", () => {
  it("writes the default values so the UI looks exactly as before", () => {
    const root = fakeRoot();
    applyTypography(DEFAULT_TYPOGRAPHY, root as never);
    expect(root.vars.get("--obby-font-ui")).toBe("'Roboto Mono', monospace");
    expect(root.vars.get("--obby-font-chat")).toBe("'Roboto Mono', monospace");
    expect(root.vars.get("--obby-font-size")).toBe("14px");
    expect(root.vars.get("--obby-line-height")).toBe("1.5");
    expect(root.attrs.get("data-density")).toBe("cosy");
  });

  it("applies a chat font, size, spacing and density", () => {
    const root = fakeRoot();
    applyTypography(
      {
        fontFamily: "system-sans",
        fontFamilyCustom: "",
        chatFontFamily: "custom",
        chatFontFamilyCustom: "Inter",
        fontSize: 16,
        lineSpacing: "relaxed",
        messageDensity: "compact",
      },
      root as never,
    );
    expect(root.vars.get("--obby-font-ui")).toMatch(/system-ui/);
    expect(root.vars.get("--obby-font-chat")).toBe("'Inter', sans-serif");
    expect(root.vars.get("--obby-font-size")).toBe("16px");
    expect(root.vars.get("--obby-line-height")).toBe("1.75");
    expect(root.attrs.get("data-density")).toBe("compact");
  });

  it("clamps the font size to the supported range", () => {
    const root = fakeRoot();
    applyTypography({ ...DEFAULT_TYPOGRAPHY, fontSize: 40 }, root as never);
    expect(root.vars.get("--obby-font-size")).toBe("18px");
    applyTypography({ ...DEFAULT_TYPOGRAPHY, fontSize: 3 }, root as never);
    expect(root.vars.get("--obby-font-size")).toBe("12px");
  });
});
