import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaAllowedHostsField } from "../../../../src/components/ui/settings/MediaAllowedHostsField";
import type {
  SettingDefinition,
  SettingValue,
} from "../../../../src/lib/settings/types";

const PLACEHOLDER = "files.example.com or a pasted link";
const INVALID =
  "Enter a site name such as files.example.com, or paste a link to it. Ports and IP addresses cannot be added.";

function setup(value?: SettingValue) {
  const onChange = vi.fn();
  render(
    <MediaAllowedHostsField
      setting={{} as SettingDefinition}
      value={value as SettingValue}
      onChange={onChange}
    />,
  );
  const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
  const addButton = screen.getByRole("button", { name: "Add" });
  const type = (text: string) =>
    fireEvent.change(input, { target: { value: text } });
  return { onChange, input, addButton, type };
}

describe("MediaAllowedHostsField", () => {
  it("adds a typed site with the button, after the sites already listed", () => {
    const { onChange, addButton, type } = setup(["a.example"]);
    type(" Files.Example.com ");
    fireEvent.click(addButton);
    expect(onChange).toHaveBeenCalledWith(["a.example", "files.example.com"]);
  });

  it("adds with Enter and keeps focus in the input", () => {
    const { onChange, input, type } = setup([]);
    input.focus();
    type("files.example.com");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["files.example.com"]);
    expect(document.activeElement).toBe(input);
  });

  it("reduces a pasted link to its host", () => {
    const { onChange, addButton, type } = setup([]);
    type("https://cdn.example.com/a/b.png?x=1#y");
    fireEvent.click(addButton);
    expect(onChange).toHaveBeenCalledWith(["cdn.example.com"]);
  });

  it("adds a wildcard as typed", () => {
    const { onChange, addButton, type } = setup([]);
    type("*.example.com");
    fireEvent.click(addButton);
    expect(onChange).toHaveBeenCalledWith(["*.example.com"]);
  });

  it("accepts a built-in image host", () => {
    const { onChange, addButton, type } = setup([]);
    type("i.imgur.com");
    fireEvent.click(addButton);
    expect(onChange).toHaveBeenCalledWith(["i.imgur.com"]);
  });

  it.each([
    ["127.0.0.1", INVALID],
    ["example.com:8443", INVALID],
    [
      "*.github.io",
      "Add the exact site instead. github.io is shared by many unrelated people.",
    ],
    [
      "co.uk",
      "Add the exact site instead. co.uk is shared by many unrelated people.",
    ],
    [
      "youtube.com",
      "Set Media Previews to Trusted Sources to preview youtube.com. It also loads from other sites, so it cannot be added here.",
    ],
    [
      "*.youtube.com",
      "Set Media Previews to Trusted Sources to preview youtube.com. It also loads from other sites, so it cannot be added here.",
    ],
    ["EXAMPLE.com", "example.com is already on the list."],
  ])("refuses %j and says why", (text, message) => {
    const { onChange, addButton, type } = setup(["example.com"]);
    type(text);
    fireEvent.click(addButton);
    expect(screen.getByText(message)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the error once the text changes", () => {
    const { addButton, type } = setup([]);
    type("127.0.0.1");
    fireEvent.click(addButton);
    expect(screen.getByText(INVALID)).toBeTruthy();
    type("127.0.0.");
    expect(screen.queryByText(INVALID)).toBeNull();
  });

  it("keeps Add off and ignores Enter while the input is empty", () => {
    const { onChange, input, addButton, type } = setup([]);
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    type("   ");
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(INVALID)).toBeNull();
  });

  it("removes one site through its labelled button", () => {
    const { onChange } = setup(["example.com", "*.cdn.example"]);
    const remove = screen.getByRole("button", { name: "Remove example.com" });
    expect(remove.getAttribute("title")).toBe("Remove example.com");
    fireEvent.click(remove);
    expect(onChange).toHaveBeenCalledWith(["*.cdn.example"]);
  });

  it("renders an empty editor with both hints when no value is stored", () => {
    setup(undefined);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.getByText(/^Paste a link to add the site/)).toBeTruthy();
    expect(screen.getByText(/^Add only sites you trust\./)).toBeTruthy();
  });
});
