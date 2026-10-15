import { describe, expect, it } from "vitest";
import {
  applyChatLook,
  DEFAULT_CHAT_LOOK,
  isValidBackgroundImage,
  MAX_BACKGROUND_CHARS,
} from "../../src/lib/chatLook";

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

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("isValidBackgroundImage", () => {
  it("accepts only base64 data URIs of raster images under the size limit", () => {
    expect(isValidBackgroundImage(png)).toBe(true);
    expect(isValidBackgroundImage("data:image/jpeg;base64,/9j/4AAQ")).toBe(
      true,
    );
    expect(isValidBackgroundImage("https://example.org/bg.png")).toBe(false);
    expect(isValidBackgroundImage("data:image/svg+xml;base64,PHN2Zz4=")).toBe(
      false,
    );
    expect(isValidBackgroundImage('data:image/png;base64,abc")')).toBe(false);
    expect(
      isValidBackgroundImage(
        `data:image/png;base64,${"A".repeat(MAX_BACKGROUND_CHARS)}`,
      ),
    ).toBe(false);
  });
});

describe("applyChatLook", () => {
  it("defaults to the pastel palette and no background", () => {
    const root = fakeRoot();
    applyChatLook(DEFAULT_CHAT_LOOK, root as never);
    expect(root.attrs.get("data-nick-palette")).toBe("pastel");
    expect(root.vars.get("--obby-chat-bg")).toBe("none");
    expect(root.vars.get("--obby-chat-bg-opacity")).toBe("0.3");
  });

  it("applies a palette, a background and its opacity", () => {
    const root = fakeRoot();
    applyChatLook(
      { nickPalette: "vivid", chatBackground: png, chatBackgroundOpacity: 55 },
      root as never,
    );
    expect(root.attrs.get("data-nick-palette")).toBe("vivid");
    expect(root.vars.get("--obby-chat-bg")).toBe(`url("${png}")`);
    expect(root.vars.get("--obby-chat-bg-opacity")).toBe("0.55");
  });

  it("ignores an invalid background and clamps opacity", () => {
    const root = fakeRoot();
    applyChatLook(
      {
        nickPalette: "mono",
        chatBackground: "https://x/y.png",
        chatBackgroundOpacity: 500,
      },
      root as never,
    );
    expect(root.vars.get("--obby-chat-bg")).toBe("none");
    expect(root.vars.get("--obby-chat-bg-opacity")).toBe("1");
  });
});
