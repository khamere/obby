import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageReactions } from "../../../src/components/message/MessageReactions";

describe("MessageReactions", () => {
  // The reaction text comes from another client, so it can be any property name.
  it.each([
    "constructor",
    "toString",
    "valueOf",
    "__proto__",
    "hasOwnProperty",
  ])("renders a reaction named %s", (name) => {
    render(
      <MessageReactions
        reactions={[
          { emoji: name, userId: "alice" },
          { emoji: name, userId: "bob" },
          { emoji: "👍", userId: "alice" },
        ]}
        currentUserUsername="bob"
        onReactionClick={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", {
      name: `Remove reaction ${name}`,
    });
    expect(chip.textContent).toBe(`${name}2`);
    expect(
      screen.getByRole("button", { name: "Add reaction 👍" }).textContent,
    ).toBe("👍1");
    expect("count" in Object).toBe(false);
  });
});
