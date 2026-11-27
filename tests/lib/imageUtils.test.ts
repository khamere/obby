import { describe, expect, test } from "vitest";
import { canLoadEmojiUrl, canShowImageUrl } from "../../src/lib/imageUtils";
import useStore from "../../src/store";

// Avatars, icons and emoji load with no link posted in chat, so the user's
// allowed sites never apply to them: these gates take a level and no list.
describe("image gates ignore the user's allowed sites", () => {
  test("a listed host is refused at Safe", () => {
    useStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        mediaVisibilityLevel: 1,
        mediaAllowedHosts: ["img.example"],
      },
    }));
    expect(canShowImageUrl("https://img.example/a.png", 1, [])).toBe(false);
    expect(canShowImageUrl("https://img.example/a.png", 2, [])).toBe(false);
    expect(canLoadEmojiUrl("https://img.example/a.png", [], 1)).toBe(false);
  });

  test("the file host still passes", () => {
    expect(
      canShowImageUrl("https://files.example/a.png", 1, [
        "https://files.example",
      ]),
    ).toBe(true);
  });
});
