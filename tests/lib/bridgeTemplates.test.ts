import { describe, expect, it } from "vitest";
import { compileTemplate, matchTemplate } from "../../src/lib/bridgeTemplates";

const m = (tpl: string, input: string) => {
  const re = compileTemplate(tpl, "message");
  return re && matchTemplate(re, input);
};

describe("compileTemplate", () => {
  it("matches the verified formats", () => {
    expect(m("[{nick}] {text}", "[mara] But I do agree")).toEqual({
      nick: "mara",
      text: "But I do agree",
    });
    expect(m("[{nick}]: {text}", "[chevron]: i use TrueNAS")).toEqual({
      nick: "chevron",
      text: "i use TrueNAS",
    });
    expect(m("<{nick}> {text}", "<Skuff> moin.. :)")).toEqual({
      nick: "Skuff",
      text: "moin.. :)",
    });
    expect(m("[{nick}] (WEB): {text}", "[homie] (WEB): lol")).toEqual({
      nick: "homie",
      text: "lol",
    });
    expect(m("[Chatbox] {nick}: {text}", "[Chatbox] 4SURE: hi there")).toEqual({
      nick: "4SURE",
      text: "hi there",
    });
    expect(m("🛰️{nick}: {text}", "🛰️neo: yo")).toEqual({
      nick: "neo",
      text: "yo",
    });
  });

  it("lets one space match a run of whitespace and allows empty text", () => {
    expect(m("[{nick}] {text}", "[a]   b")).toEqual({ nick: "a", text: "b" });
    expect(m("[{nick}] {text}", "[a] ")).toEqual({ nick: "a", text: "" });
  });

  it("does not match other prefixes or an empty nick", () => {
    expect(m("[{nick}] {text}", "[New-Request]-[Name: x]")).toBeNull();
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
    expect(re && matchTemplate(re, "(Jeditwo)")).toEqual({
      nick: "Jeditwo",
      text: "",
    });
    expect(re && matchTemplate(re, "(Jeditwo)x")).toBeNull();
    expect(re && matchTemplate(re, "Jeditwo")).toBeNull();
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
    expect(m("{nick}🛰️ {text}", "neo🛰️ x🛰️ hi")).toEqual({
      nick: "neo",
      text: "x🛰️ hi",
    });
    // the nick may not run through the stop character
    expect(m("{nick}🛰️ {text}", "a🛰️b🛰️ hi")).toBeNull();
  });

  it("rejects a nick longer than 32 characters", () => {
    expect(m("[{nick}] {text}", `[${"n".repeat(33)}] hi`)).toBeNull();
  });
});
