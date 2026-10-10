import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotdBlock } from "../../../src/components/message/MotdBlock";

describe("MotdBlock", () => {
  const html = renderToStaticMarkup(
    <MotdBlock
      lines={["  _  _", "", "\x0304red\x03 https://example.com"]}
      keyPrefix="m"
    />,
  );

  it("renders monospace with whitespace preserved", () => {
    expect(html).toContain("font-mono");
    expect(html).toContain("whitespace-pre");
    expect(html).toContain("  _  _");
  });

  it("keeps blank lines as a visible row", () => {
    expect(html).toContain("<div> </div>");
  });

  it("applies mIRC colours and links URLs", () => {
    expect(html).toMatch(/style="color:[^"]+">red<\/span>/);
    expect(html).toContain('href="https://example.com"');
  });
});
