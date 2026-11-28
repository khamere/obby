import { describe, expect, it } from "vitest";
import { compileTemplate, matchTemplate } from "../../src/lib/bridgeTemplates";

const m = (tpl: string, input: string) => {
  const re = compileTemplate(tpl, "message");
  return re && matchTemplate(re, input);
};

describe("compileTemplate", () => {
  it("matches common bridge formats", () => {
    expect(m("[{nick}] {text}", "[mara] good morning")).toEqual({
      nick: "mara",
      text: "good morning",
    });
    expect(m("[{nick}]: {text}", "[nilo]: hello again")).toEqual({
      nick: "nilo",
      text: "hello again",
    });
    expect(m("<{nick}> {text}", "<Juno> hi :)")).toEqual({
      nick: "Juno",
      text: "hi :)",
    });
    expect(m("[{nick}] (WEB): {text}", "[ozzie] (WEB): lol")).toEqual({
      nick: "ozzie",
      text: "lol",
    });
    expect(m("[Chatbox] {nick}: {text}", "[Chatbox] 7Nova: hi there")).toEqual({
      nick: "7Nova",
      text: "hi there",
    });
    expect(m("🛰️{nick}: {text}", "🛰️vesper: yo")).toEqual({
      nick: "vesper",
      text: "yo",
    });
  });

  it("lets one space match a run of whitespace and allows empty text", () => {
    expect(m("[{nick}] {text}", "[a]   b")).toEqual({ nick: "a", text: "b" });
    expect(m("[{nick}] {text}", "[a] ")).toEqual({ nick: "a", text: "" });
  });

  it("does not match other prefixes or an empty nick", () => {
    expect(m("[{nick}] {text}", "[Notice]-[Name: x]")).toBeNull();
    expect(m("[{nick}] {text}", "[] hi")).toBeNull();
    expect(m("[{nick}] {text}", "plain text")).toBeNull();
  });

  it("throws away {_} and keeps the nick", () => {
    expect(m("»{nick} ({_})« {text}", "»Name (Rank)« hi")).toEqual({
      nick: "Name",
      text: "hi",
    });
  });

  it("compiles nick templates anchored at both ends", () => {
    const re = compileTemplate("({nick})", "nick");
    expect(re && matchTemplate(re, "(Tobias)")).toEqual({
      nick: "Tobias",
      text: "",
    });
    expect(re && matchTemplate(re, "(Tobias)x")).toBeNull();
    expect(re && matchTemplate(re, "Tobias")).toBeNull();
  });

  it("rejects invalid templates", () => {
    expect(compileTemplate("[{nick}]", "message")).toBeNull();
    expect(compileTemplate("{text}", "message")).toBeNull();
    expect(compileTemplate("[{nick}] {nick} {text}", "message")).toBeNull();
    expect(compileTemplate("[{bogus}] {text}", "message")).toBeNull();
    expect(compileTemplate("({nick}) {text}", "nick")).toBeNull();
    expect(
      compileTemplate(`${"x".repeat(200)}{nick} {text}`, "message"),
    ).toBeNull();
  });

  it("treats a run of spaces in the template as one, so no two quantifiers sit side by side", () => {
    const re = compileTemplate("[{nick}]   {text}", "message");
    expect(re?.source.match(/\\s\+/g)).toHaveLength(1);
    expect(re && matchTemplate(re, "[a] b")).toEqual({ nick: "a", text: "b" });
  });

  it("requires a literal after {_} and allows only one", () => {
    expect(compileTemplate("{_}{nick} {text}", "message")).toBeNull();
    expect(compileTemplate("{nick} {_}{text}", "message")).toBeNull();
    expect(compileTemplate("[{_}] [{_}] {nick} {text}", "message")).toBeNull();
    expect(compileTemplate("[{_}] {nick} {text}", "message")).not.toBeNull();
  });

  it("uses a whole astral character as the stop after {nick}", () => {
    expect(m("{nick}🛰️ {text}", "vesper🛰️ x🛰️ hi")).toEqual({
      nick: "vesper",
      text: "x🛰️ hi",
    });
    // the nick may not run through the stop character
    expect(m("{nick}🛰️ {text}", "a🛰️b🛰️ hi")).toBeNull();
  });

  it("rejects a nick longer than 32 characters", () => {
    expect(m("[{nick}] {text}", `[${"n".repeat(33)}] hi`)).toBeNull();
  });

  it("leaves invisible characters out of the nick wherever the bridge put them", () => {
    for (const nick of [
      "m\u200Bara",
      "ma\u200Cra",
      "mar\u200Da",
      "m\u2060ara",
      "m\uFEFFara",
      "\u200Bmara",
      "mara\uFEFF",
      "\u200Bm\u200Ca\u200Dr\u2060a\uFEFF",
    ]) {
      expect(m("[{nick}] {text}", `[${nick}] hi`)).toEqual({
        nick: "mara",
        text: "hi",
      });
    }
    expect(m("[Chatbox] {nick}: {text}", "[Chatbox] 7\u200BNova: hi")).toEqual({
      nick: "7Nova",
      text: "hi",
    });
    const re = compileTemplate("({nick})", "nick");
    expect(re && matchTemplate(re, "(To\u200Bbias)")).toEqual({
      nick: "Tobias",
      text: "",
    });
  });

  it("keeps a joiner that shapes an emoji or a script's letters", () => {
    for (const nick of [
      "\u{1F469}\u200D\u{1F4BB}",
      "\u{1F3F3}\uFE0F\u200D\u{1F308}",
      "\u0639\u0644\u06CC\u200C\u0631\u0636\u0627",
      "mara\u{1F469}\u200D\u{1F4BB}",
    ]) {
      expect(m("[{nick}] {text}", `[${nick}] hi`)).toEqual({
        nick,
        text: "hi",
      });
    }
    expect(
      m("[{nick}] {text}", "[\u{1F469}\u200B\u200D\u{1F4BB}\uFEFF] hi"),
    ).toEqual({ nick: "\u{1F469}\u200D\u{1F4BB}", text: "hi" });
  });

  it("leaves out a joiner that touches an ASCII character, an end of the name or another joiner", () => {
    for (const [written, nick] of [
      ["m\u200D\u{1F4BB}", "m\u{1F4BB}"],
      ["\u{1F469}\u200Cx", "\u{1F469}x"],
      ["\u200D\u{1F469}", "\u{1F469}"],
      ["\u{1F469}\u200D", "\u{1F469}"],
      ["\u{1F469}\u200D\u200D\u{1F4BB}", "\u{1F469}\u{1F4BB}"],
      ["\u{1F469}\u200C\u200D\u200C\u{1F4BB}", "\u{1F469}\u{1F4BB}"],
    ]) {
      expect(m("[{nick}] {text}", `[${written}] hi`)).toEqual({
        nick,
        text: "hi",
      });
    }
  });

  it("keeps invisible characters in the text", () => {
    const text =
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} zw\u200Bsp \u2060\uFEFFx";
    expect(m("[{nick}] {text}", `[m\u200Bara] ${text}`)).toEqual({
      nick: "mara",
      text,
    });
  });

  it("does not match a nick made of invisible characters only", () => {
    expect(m("[{nick}] {text}", "[\u200B] hi")).toBeNull();
    expect(
      m("[{nick}] {text}", "[\u200B\u200C\u200D\u2060\uFEFF] hi"),
    ).toBeNull();
    const re = compileTemplate("({nick})", "nick");
    expect(re && matchTemplate(re, "(\u200D)")).toBeNull();
  });

  it("counts only the visible characters against the nick limit", () => {
    const spaced = (n: number) =>
      Array.from({ length: n }, () => "n").join("\u200B");
    expect(m("[{nick}] {text}", `[${spaced(32)}] hi`)).toEqual({
      nick: "n".repeat(32),
      text: "hi",
    });
    expect(m("[{nick}] {text}", `[${spaced(33)}] hi`)).toBeNull();
  });

  it("still stops the nick at the literal that follows it", () => {
    expect(m("{nick}: {text}", "ma\u200Bra: a: b")).toEqual({
      nick: "mara",
      text: "a: b",
    });
    expect(m("{nick} {text}", "m\uFEFFara\uFEFF hello there")).toEqual({
      nick: "mara",
      text: "hello there",
    });
  });
});
