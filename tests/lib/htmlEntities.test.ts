import { describe, expect, it } from "vitest";
import {
  decodeCharacterReferences,
  decodeHtmlEntities,
  escapeHtml,
} from "../../src/lib/htmlEntities";

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(
      decodeHtmlEntities("&quot;OwO what&#39;s this&quot; &amp; it&#x2019;s"),
    ).toBe('"OwO what\'s this" & it’s');
  });

  it("decodes the typography entities page titles use", () => {
    expect(
      decodeHtmlEntities("PR #42 &middot; repo &ndash; it&rsquo;s&hellip;"),
    ).toBe("PR #42 · repo – it’s…");
  });

  it("decodes each entity once", () => {
    expect(decodeHtmlEntities("&amp;quot;")).toBe("&quot;");
  });

  it("keeps unknown entities as written", () => {
    expect(decodeHtmlEntities("&bogus; &#99999999;")).toBe(
      "&bogus; &#99999999;",
    );
  });

  it.each(["&constructor;", "&toString;", "&__proto__;", "&valueOf;"])(
    "keeps %s, a name every object inherits, as written",
    (entity) => {
      expect(decodeHtmlEntities(`a ${entity} b`)).toBe(`a ${entity} b`);
    },
  );
});

describe("decodeHtmlEntities on an older engine", () => {
  it("decodes without Object.hasOwn, which older webviews lack", () => {
    const hasOwn = Object.hasOwn;
    // biome-ignore lint/suspicious/noExplicitAny: we take a built-in away for the test
    (Object as any).hasOwn = undefined;
    try {
      expect(decodeHtmlEntities("a &lt; b &constructor;")).toBe(
        "a < b &constructor;",
      );
    } finally {
      Object.hasOwn = hasOwn;
    }
  });
});

describe("decodeCharacterReferences", () => {
  it("decodes every reference a page would", () => {
    expect(decodeCharacterReferences("caf&eacute; &#x22;a&#34; &amp;lt;")).toBe(
      'café "a" &lt;',
    );
  });

  it("keeps unknown references as written", () => {
    expect(decodeCharacterReferences("&constructor; &bogus;")).toBe(
      "&constructor; &bogus;",
    );
  });

  it("returns markup as text", () => {
    const markup = "</textarea><img src=x onerror=alert(1)>&lt;b&gt;";
    expect(decodeCharacterReferences(markup)).toBe(
      "</textarea><img src=x onerror=alert(1)><b>",
    );
  });
});

describe("escapeHtml", () => {
  it("escapes every character that can open markup", () => {
    expect(escapeHtml(`<img src="x" onerror='y'> & co`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt; &amp; co",
    );
  });
});
