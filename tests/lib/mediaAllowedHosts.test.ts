import { describe, expect, test } from "vitest";
import {
  isWildcardBaseAllowed,
  matchAllowedMediaHost,
  parseMediaHostEntry,
  sanitizeMediaAllowedHosts,
} from "../../src/lib/mediaAllowedHosts";

describe("parseMediaHostEntry", () => {
  test.each([
    ["example.com", "example.com"],
    [" Example.COM ", "example.com"],
    ["https://Files.Example.com/a/b.png?x#y", "files.example.com"],
    ["http://example.com/x", "example.com"],
    ["example.com.", "example.com"],
    ["example.com:443", "example.com"],
    ["www.example.com", "www.example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["*.example.com", "*.example.com"],
    ["*.example.com/path", "*.example.com"],
    ["name.pages.dev", "name.pages.dev"],
    ["mybucket.s3.amazonaws.com", "mybucket.s3.amazonaws.com"],
  ])("accepts %j as %j", (input, entry) => {
    expect(parseMediaHostEntry(input)).toEqual({ entry });
  });

  test.each([
    [""],
    ["   "],
    ["*"],
    ["*."],
    ["*.*.example.com"],
    ["example.com:8443"],
    ["user@example.com"],
    ["https://u:p@example.com/"],
    ["mailto:a@example.com"],
    ["localhost"],
    ["127.0.0.1"],
    ["127.1"],
    ["2130706433"],
    ["0x7f.0.0.1"],
    ["[::1]"],
    ["ftp://example.com"],
    ["javascript:alert(1)"],
    ["exa mple.com"],
    ["example..com"],
    ["ex_ample.com"],
    [
      `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.example`,
    ],
  ])("refuses %j as invalid", (input) => {
    expect(parseMediaHostEntry(input)).toEqual({ error: "invalid" });
  });

  test.each([
    ["co.uk", "co.uk"],
    ["*.co.uk", "co.uk"],
    ["github.io", "github.io"],
    ["*.github.io", "github.io"],
    ["*.s3.amazonaws.com", "s3.amazonaws.com"],
    ["*.name.pages.dev", "name.pages.dev"],
    ["storage.googleapis.com", "storage.googleapis.com"],
    ["s3.eu-west-1.amazonaws.com", "s3.eu-west-1.amazonaws.com"],
  ])("refuses %j as shared", (input, host) => {
    expect(parseMediaHostEntry(input)).toEqual({ error: "shared", host });
  });

  test("its own output parses to the same entry", () => {
    for (const input of [
      " Example.COM ",
      "https://Files.Example.com/a/b.png",
      "*.Example.com",
      "bücher.example",
    ]) {
      const { entry } = parseMediaHostEntry(input);
      expect(entry).toBeTruthy();
      expect(parseMediaHostEntry(entry as string)).toEqual({ entry });
    }
  });

  test("a pasted link never yields a wildcard", () => {
    expect(parseMediaHostEntry("https://*.example.com/a.png")).toEqual({
      error: "invalid",
    });
    expect(parseMediaHostEntry("https://sub.example.com/*.png").entry).toBe(
      "sub.example.com",
    );
  });
});

describe("isWildcardBaseAllowed", () => {
  test.each(["example.com", "media.example.org"])("allows %j", (base) => {
    expect(isWildcardBaseAllowed(base)).toBe(true);
  });

  test.each([
    "com",
    "",
    "co.uk",
    "github.io",
    "x.github.io",
    "s3.amazonaws.com",
    "127.0.0.1",
  ])("refuses %j", (base) => {
    expect(isWildcardBaseAllowed(base)).toBe(false);
  });
});

describe("sanitizeMediaAllowedHosts", () => {
  test.each([
    [undefined],
    [null],
    ["example.com"],
    [5],
    [{ 0: "example.com" }],
  ])("turns %j into an empty list", (value) => {
    expect(sanitizeMediaAllowedHosts(value)).toEqual([]);
  });

  test("keeps only entries already in stored form, once each", () => {
    expect(
      sanitizeMediaAllowedHosts([
        "example.com",
        5,
        null,
        "Example.com",
        "*.a.example",
        "*.co.uk",
        "127.0.0.1",
        "example.com",
        "https://b.example",
        "storage.googleapis.com",
      ]),
    ).toEqual(["example.com", "*.a.example"]);
  });
});

describe("matchAllowedMediaHost", () => {
  const exact = ["files.example.com"];
  const wildcard = ["*.example.com"];

  test.each([
    "https://files.example.com/a.png",
    "HTTPS://FILES.EXAMPLE.COM/a.png",
    "https://files.example.com:443/a.png",
    // The parser reads a backslash as a slash, so the host really is files.example.com.
    "https://files.example.com\\@evil.net/a.png",
  ])("exact entry matches %j", (url) => {
    expect(matchAllowedMediaHost(url, exact)).toBe("files.example.com");
  });

  test.each([
    "http://files.example.com/a.png",
    "https://files.example.com:8443/a.png",
    "https://example.com/a.png",
    "https://x.files.example.com/a.png",
    "https://www.files.example.com/a.png",
    "https://files.example.com.evil.net/a.png",
    "https://notfiles.example.com/a.png",
    "https://evil.net/files.example.com/a.png",
    "https://evil.net/?u=https://files.example.com/a.png",
    "https://evil.net/#files.example.com",
    "https://files.example.com@evil.example/a.png",
    "https://files.example.com./a.png",
    "//files.example.com/a.png",
    "/a.png",
    "not a url",
    "",
  ])("exact entry does not match %j", (url) => {
    expect(matchAllowedMediaHost(url, exact)).toBeNull();
  });

  test.each([
    "https://example.com/a.png",
    "https://i.example.com/a.png",
    "https://a.b.example.com/a.png",
  ])("wildcard entry matches %j", (url) => {
    expect(matchAllowedMediaHost(url, wildcard)).toBe("*.example.com");
  });

  test.each([
    "https://notexample.com/a.png",
    "https://example.com.evil.net/a.png",
    "http://i.example.com/a.png",
    "https://i.example.com:8443/a.png",
    "https://user@i.example.com/a.png",
  ])("wildcard entry does not match %j", (url) => {
    expect(matchAllowedMediaHost(url, wildcard)).toBeNull();
  });

  test("a Unicode URL matches its punycode entry", () => {
    expect(
      matchAllowedMediaHost("https://bücher.example/a.png", [
        "xn--bcher-kva.example",
      ]),
    ).toBe("xn--bcher-kva.example");
  });

  test.each([[undefined], [null], [[]], [{}], ["example.com.evil.net"]])(
    "hosts given as %j match nothing",
    (hosts) => {
      expect(
        matchAllowedMediaHost("https://example.com.evil.net/a.png", hosts),
      ).toBeNull();
      expect(
        matchAllowedMediaHost("https://example.com/a.png", hosts),
      ).toBeNull();
    },
  );

  test.each([[["com"]], [["*.com"]], [["*.co.uk"]], [["*."]], [[5, null]]])(
    "a stored %j widens nothing",
    (hosts) => {
      expect(matchAllowedMediaHost("https://a.co.uk/x.png", hosts)).toBeNull();
      expect(
        matchAllowedMediaHost("https://example.com./x.png", hosts),
      ).toBeNull();
      expect(
        matchAllowedMediaHost("https://example.com/x.png", hosts),
      ).toBeNull();
    },
  );

  test("returns the first entry that matches", () => {
    expect(
      matchAllowedMediaHost("https://i.example.com/a.png", [
        "other.example",
        "*.example.com",
        "i.example.com",
      ]),
    ).toBe("*.example.com");
  });
});
