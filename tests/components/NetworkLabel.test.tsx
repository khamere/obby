import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { NetworkLabel } from "../../src/components/layout/NetworkLabel";

test("preserves the connection name and falls back when a wordmark fails", () => {
  const { container, rerender } = render(
    <NetworkLabel name="DKOKTO ERGO" logo="/network-logos/dkokto.svg" />,
  );
  expect(screen.getByText("DKOKTO ERGO")).toHaveClass("sr-only");
  fireEvent.error(container.querySelector("img")!);
  expect(screen.getByText("DKOKTO ERGO")).not.toHaveClass("sr-only");
  expect(container.querySelector("img")).toBeNull();
  rerender(
    <NetworkLabel name="upload.cx" logo="/network-logos/upload-cx.svg" />,
  );
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "/network-logos/upload-cx.svg",
  );
});

test("unmatched networks retain their text labels", () => {
  const { container } = render(<NetworkLabel name="My private network" />);
  expect(screen.getByText("My private network")).toBeVisible();
  expect(container.querySelector("img")).toBeNull();
});
