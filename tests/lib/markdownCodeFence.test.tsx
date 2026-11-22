import { render } from "@testing-library/react";
import { marked } from "marked";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  processMarkdownInText,
  sanitizeMarkdownHtml,
} from "../../src/lib/ircUtils";

const renderMessage = (text: string) =>
  render(<div>{processMarkdownInText(text, false, true, "k")}</div>).container;

const label = (container: HTMLElement) =>
  container.querySelector(".code-block-header")?.textContent;

// Only the id we generate and a validated language class may sit on a code
// block, whatever the sender wrote after the fence.
const codeAttributes = (container: HTMLElement) =>
  [...(container.querySelector("pre code")?.attributes ?? [])]
    .map((attr) => attr.name)
    .filter((name) => name !== "id");

// The fence info string is free text from the sender, so its first word may
// name a class only when all of it is a language name: a quote in it would
// add attributes, and a style with url() fetches from any host without a click.
describe("markdown code fence language", () => {
  const overlay =
    'x"style="background:url(https://attacker.example/b);position:fixed;inset:0;z-index:99999';

  it("keeps a quote in a one-line fence out of the attributes", () => {
    const container = renderMessage(`\`\`\`${overlay}`);
    expect(codeAttributes(container)).toEqual([]);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.innerHTML).not.toContain("attacker.example");
    expect(label(container)).toBe('x"style="background:url(https://…');
  });

  it.each(["```", "~~~"])(
    "keeps a quote after %s above a code body out of the attributes",
    (fence) => {
      const container = renderMessage(
        `${fence}${overlay}\nconst a = 1;\n${fence}`,
      );
      const code = container.querySelector("pre code");
      expect(code?.textContent).toBe("const a = 1;");
      expect(codeAttributes(container)).toEqual([]);
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
    expect(label(container)).toBe("js");
  });

  it.each([
    ["C/C++", "C/C++"],
    ["c/c++ extra words", "c/c++"],
    ['a"b', 'a"b'],
    ["a'b=c", "a'b=c"],
    ["<b>", "<b>"],
    ["a&quot;b", 'a"b'],
    ["x".repeat(33), `${"x".repeat(32)}…`],
    [`${"x".repeat(32)}"y`, `${"x".repeat(32)}…`],
  ])("shows the fence word %s as text and gives it no class", (word, shown) => {
    const container = renderMessage(`\`\`\`${word}\nint a = 1;\n\`\`\``);
    expect(codeAttributes(container)).toEqual([]);
    expect(label(container)).toBe(shown);
    expect(container.querySelector("[data-fence-label]")).toBeNull();
    expect(container.querySelector("pre code")?.innerHTML).toBe("int a = 1;");
  });

  it("keeps a language name of 32 characters", () => {
    const name = "x".repeat(32);
    const container = renderMessage(`\`\`\`${name}\na = 1\n\`\`\``);
    expect(container.querySelector("pre code")?.className).toBe(
      `language-${name}`,
    );
    expect(label(container)).toBe(name);
  });

  it("labels a fence with no word as plain text", () => {
    const container = renderMessage("```\n\n```");
    expect(label(container)).toBe("plain text");
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

  it("keeps the default IRC colour of a line", () => {
    const safe = sanitizeMarkdownHtml(
      '<span style="color:inherit;background-color:#00007F">x</span>',
    );
    expect(safe).toContain('style="color:inherit;background-color:#00007F"');
  });

  it("drops a style the parsed Markdown carries when a message renders", () => {
    const parse = vi
      .spyOn(marked, "parse")
      .mockReturnValue('<p><span style="text-decoration:blink">x</span></p>');
    try {
      const container = renderMessage("**x**");
      expect(parse).toHaveBeenCalled();
      expect(container.querySelector("p span")?.textContent).toBe("x");
      expect(container.querySelector("[style]")).toBeNull();
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    "color:red",
    "color:#FF0000;background-color:url(x)",
    "color:#FF00",
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

// The highlighter loads after the first render, so these wait for it: a fence
// word reaches it only as a whole language name, never as its leading part.
describe("markdown code fence highlighting", () => {
  beforeAll(async () => {
    await import("../../src/lib/hljs");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const highlighted = (container: HTMLElement) =>
    container.querySelector("pre code [class^='hljs-']") !== null;

  it.each([
    ["c++", "c++"],
    ["js foo", "js"],
    ["C", "C"],
  ])("highlights a fence opened with %s as %s", (info, language) => {
    const container = renderMessage(`\`\`\`${info}\nconst int a = 1;\n\`\`\``);
    expect(container.querySelector("pre code")?.className).toBe(
      `language-${language}`,
    );
    expect(label(container)).toBe(language);
    expect(highlighted(container)).toBe(true);
  });

  it.each([
    ["C/C++", "C/C++", []],
    ["objective-c", "objective-c", ["class"]],
    ['js"x', 'js"x', []],
    [`${"c".repeat(33)}`, `${"c".repeat(32)}…`, []],
  ])(
    "leaves a fence opened with %s unhighlighted",
    (info, shown, attributes) => {
      const container = renderMessage(
        `\`\`\`${info}\nconst int a = 1;\n\`\`\``,
      );
      expect(codeAttributes(container)).toEqual(attributes);
      expect(label(container)).toBe(shown);
      expect(highlighted(container)).toBe(false);
      expect(container.querySelector("pre code")?.textContent).toBe(
        "const int a = 1;",
      );
    },
  );
});
