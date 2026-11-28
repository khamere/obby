import { describe, expect, it } from "vitest";
import { markedFavicon, unreadTitle } from "../../src/lib/unreadTitle";

const PREFIX = "data:image/svg+xml,";
const svgWithDot = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image href="data:image/png;base64,AAAA" width="64" height="64"/><circle cx="48" cy="16" r="16" fill="#fff"/><circle cx="48" cy="16" r="12" fill="${fill}"/></svg>`;

describe("unreadTitle", () => {
  it("is the app name when nothing is unread", () => {
    expect(unreadTitle("none", 0)).toBe("Obby");
  });

  it("puts a bullet before the app name for plain unread", () => {
    expect(unreadTitle("unread", 0)).toBe("• Obby");
  });

  it("puts the uncapped mention count before the app name", () => {
    expect(unreadTitle("mention", 3)).toBe("(3) Obby");
    expect(unreadTitle("mention", 120)).toBe("(120) Obby");
  });
});

describe("markedFavicon", () => {
  it("wraps the icon in an SVG with a ringed dot", () => {
    const url = markedFavicon("data:image/png;base64,AAAA", [242, 63, 67]);
    expect(url.startsWith(PREFIX)).toBe(true);
    expect(decodeURIComponent(url.slice(PREFIX.length))).toBe(
      svgWithDot("rgb(242,63,67)"),
    );
  });

  it("changes only the dot colour between levels", () => {
    const url = markedFavicon("data:image/png;base64,AAAA", [88, 101, 242]);
    expect(decodeURIComponent(url.slice(PREFIX.length))).toBe(
      svgWithDot("rgb(88,101,242)"),
    );
  });
});
