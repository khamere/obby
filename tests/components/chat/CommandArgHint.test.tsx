import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandArgHint } from "../../../src/components/chat/CommandArgHint";

let isTouch = false;
vi.mock("../../../src/hooks/useIsTouchInput", () => ({
  useIsTouchInput: () => isTouch,
}));

const param = {
  name: "topic",
  type: "string" as const,
  description: "topic name",
};

describe("CommandArgHint", () => {
  beforeEach(() => {
    isTouch = false;
  });

  it("shows a cancel button on desktop (mouse) input and fires onCancel", () => {
    const onCancel = vi.fn();
    render(<CommandArgHint param={param} onCancel={onCancel} />);
    const button = screen.getByLabelText("Cancel command");
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("still shows the cancel button on touch input", () => {
    isTouch = true;
    render(<CommandArgHint param={param} onCancel={() => {}} />);
    expect(screen.getByLabelText("Cancel command")).toBeTruthy();
  });

  it("shows the parameter name and description", () => {
    render(<CommandArgHint param={param} onCancel={() => {}} />);
    expect(screen.getByText("topic")).toBeTruthy();
    expect(screen.getByText("topic name")).toBeTruthy();
  });
});
