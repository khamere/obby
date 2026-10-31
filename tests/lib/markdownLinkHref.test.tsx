import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { processMarkdownInText } from "../../src/lib/ircUtils";

// marked lets a link destination contain quotes, so the renderers must
// escape the href for the attribute or a message could add attributes
// (a style with url() fetches from any host without a click).
describe("markdown link hrefs", () => {
  const breakout =
    'https://a.example/"style="background:url(https://attacker.example/css)';

  it("keeps a quote in a link destination inside the href", () => {
    const { container } = render(
      <div>{processMarkdownInText(`[x](${breakout})`, false, true, "k")}</div>,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(breakout);
    expect(link?.getAttribute("style")).toBeNull();
  });

  it("keeps a quote in an image destination inside the href", () => {
    const { container } = render(
      <div>{processMarkdownInText(`![x](${breakout})`, false, true, "k")}</div>,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(breakout);
    expect(link?.getAttribute("style")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("still links an ordinary destination", () => {
    const { container } = render(
      <div>
        {processMarkdownInText(
          "[docs](https://example.com/a?b=1&c=2)",
          false,
          true,
          "k",
        )}
      </div>,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a?b=1&c=2",
    );
  });
});
