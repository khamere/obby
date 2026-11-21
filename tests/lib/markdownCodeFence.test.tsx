import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  processMarkdownInText,
  sanitizeMarkdownHtml,
} from "../../src/lib/ircUtils";

const renderMessage = (text: string) =>
  render(<div>{processMarkdownInText(text, false, true, "k")}</div>).container;

// The fence info string is free text from the sender, so only its leading
// language name may reach an attribute: a quote in it would add attributes,
// and a style with url() fetches from any host without a click.
describe("markdown code fence language", () => {
  const overlay =
    'x"style="background:url(https://attacker.example/b);position:fixed;inset:0;z-index:99999';

  it("keeps a quote in a one-line fence out of the attributes", () => {
    const container = renderMessage(`\`\`\`${overlay}`);
    const code = container.querySelector("pre code");
    expect(code?.className).toBe("language-x");
    expect(code?.getAttribute("style")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.innerHTML).not.toContain("attacker.example");
  });

  it.each(["```", "~~~"])(
    "keeps a quote after %s above a code body out of the attributes",
    (fence) => {
      const container = renderMessage(
        `${fence}${overlay}\nconst a = 1;\n${fence}`,
      );
      const code = container.querySelector("pre code");
      expect(code?.textContent).toBe("const a = 1;");
      expect(code?.className).toBe("language-x");
      expect(container.querySelector("[style]")).toBeNull();
      expect(container.innerHTML).not.toContain("attacker.example");
    },
  );

  it("takes the language from the first word of the info string", () => {
    const container = renderMessage(
      '```js title="a" style="position:fixed"\nconst a = 1;\n```',
    );
    const code = container.querySelector("pre code");
    expect(code?.className).toBe("language-js");
    expect(code?.getAttribute("style")).toBeNull();
    expect(code?.getAttribute("title")).toBeNull();
  });

  it.each(["py", "c++", "c#", "objective-c", "asp.net"])(
    "keeps the language name %s",
    (name) => {
      const container = renderMessage(`\`\`\`${name}\na = 1\n\`\`\``);
      expect(container.querySelector("pre code")?.className).toBe(
        `language-${name}`,
      );
      expect(
        container.querySelector(".code-block-header")?.textContent,
      ).toContain(name);
    },
  );
});

// The sanitizer keeps a style attribute only when it is one the renderer
// writes itself, so an attribute smuggled in by any route cannot restyle
// the page or load a remote resource.
describe("markdown inline styles", () => {
  it("keeps the IRC colour of a line", () => {
    const container = renderMessage("\x0304,02**red** on blue");
    const style = container.querySelector("span[style]")?.getAttribute("style");
    expect(style).toBe("color:#FF0000;background-color:#00007F");
  });

  it("keeps a hex IRC colour of a line", () => {
    const container = renderMessage("\x04FF8800**orange**");
    expect(container.querySelector("span[style]")?.getAttribute("style")).toBe(
      "color:#FF8800",
    );
  });

  it.each([
    "position:fixed;inset:0;z-index:99999",
    "background:url(https://attacker.example/b)",
    "color:#FF0000;background-image:url(https://attacker.example/b)",
    "max-height: 150px; position: fixed",
  ])("drops the style %s", (style) => {
    const safe = sanitizeMarkdownHtml(`<p><span style="${style}">x</span></p>`);
    expect(safe).toBe("<p><span>x</span></p>");
  });

  it("keeps the other attributes of an element that loses its style", () => {
    const safe = sanitizeMarkdownHtml(
      '<code id="code-1" class="language-x" style="position:fixed">x</code>',
    );
    expect(safe).toBe('<code id="code-1" class="language-x">x</code>');
  });

  it("keeps the height limit on an inline image", () => {
    const container = render(
      <div>
        {processMarkdownInText(
          "![x](https://a.example/i.png)",
          true,
          true,
          "k",
        )}
      </div>,
    ).container;
    expect(container.querySelector("img")?.getAttribute("style")).toBe(
      "max-height: 150px;",
    );
  });
});
