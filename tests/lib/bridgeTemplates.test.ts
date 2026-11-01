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

  it("rejects a nick longer than 32 characters", () => {
    expect(m("[{nick}] {text}", `[${"n".repeat(33)}] hi`)).toBeNull();
  });
});
