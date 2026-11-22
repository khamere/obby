import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomCssField } from "../../../../src/components/ui/settings/CustomCssField";
import {
  getCustomCssState,
  resetCustomCssForTests,
  setSecondReadingForTests,
} from "../../../../src/lib/customCss";

// The field reads nothing from its setting, so the props only fill the type.
const props = { value: null, onChange: () => {} } as unknown as Parameters<
  typeof CustomCssField
>[0];

const SAVED = "Your CSS was saved.";
const NO_ROOM =
  "Use a smaller stylesheet. This one does not fit in this browser's storage.";
const NO_STORAGE =
  "This browser does not let Obby store data, so nothing was saved.";
const REFUSED = "This stylesheet could not be made safe, so it was not saved.";

function saveOwn(text: string) {
  render(<CustomCssField {...props} />);
  const editor = screen.getByPlaceholderText(
    "Paste CSS here or upload a .css file",
  ) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: text } });
  const save = screen.getAllByRole("button", { name: "Save" });
  fireEvent.click(save[save.length - 1]);
  return editor;
}

describe("CustomCssField", () => {
  let backing: Map<string, string>;

  beforeEach(() => {
    resetCustomCssForTests();
    backing = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => backing.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      backing.set(k, v);
    });
  });
  afterEach(() => {
    resetCustomCssForTests();
    vi.restoreAllMocks();
  });

  it("confirms own CSS that was stored", () => {
    const editor = saveOwn(".a{color:red}");
    expect(screen.getByText(SAVED)).toBeTruthy();
    expect(editor.value).toBe(".a{color:red}");
    expect(backing.get("obby.customCss")).toBe(".a{color:red}");
  });

  it("keeps the text and says so when storage has no room for it", () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const editor = saveOwn(".a{color:red}");
    expect(screen.getByText(NO_ROOM)).toBeTruthy();
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(editor.value).toBe(".a{color:red}");
    expect(getCustomCssState().own).toBe("");
  });

  it("names storage that is closed to us instead of asking for a smaller stylesheet", () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const editor = saveOwn(".a{color:red}");
    expect(screen.getByText(NO_STORAGE)).toBeTruthy();
    expect(screen.queryByText(NO_ROOM)).toBeNull();
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(editor.value).toBe(".a{color:red}");
  });

  it("keeps the text and says so when the stylesheet was refused as a whole", () => {
    // no known stylesheet fails the second reading, so a stand-in makes it fail here
    setSecondReadingForTests(() => 1);
    const text = ".a{background:url(https://evil.example/a)}";
    const editor = saveOwn(text);
    expect(screen.getByText(REFUSED)).toBeTruthy();
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(editor.value).toBe(text);
    expect(backing.has("obby.customCss")).toBe(false);
  });
});
