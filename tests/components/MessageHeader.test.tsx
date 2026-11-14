import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageHeader } from "../../src/components/message/MessageHeader";

vi.mock("../../src/lib/ircUtils", () => ({
  getColorStyle: vi.fn(() => ({})),
}));

afterEach(cleanup);

describe("MessageHeader", () => {
  it("renders the full nick when userId contains a hyphen", () => {
    render(
      <MessageHeader
        userId="user-something"
        timestamp={new Date("2024-01-01T12:00:00Z")}
        theme="discord"
      />,
    );

    expect(screen.getByText("user-something")).toBeInTheDocument();
    expect(screen.queryByText("user")).not.toBeInTheDocument();
  });

  it("labels a message saved on this device for screen readers", () => {
    const { rerender } = render(
      <MessageHeader
        userId="alice"
        timestamp={new Date("2024-01-01T12:00:00Z")}
        theme="discord"
        isSavedLocally
      />,
    );
    expect(
      screen.getByRole("img", { name: "Saved on this device" }),
    ).toBeInTheDocument();

    rerender(
      <MessageHeader
        userId="alice"
        timestamp={new Date("2024-01-01T12:00:00Z")}
        theme="discord"
      />,
    );
    expect(
      screen.queryByRole("img", { name: "Saved on this device" }),
    ).not.toBeInTheDocument();
  });

  it("shows the bridge marker, the display nick and the original line", () => {
    render(
      <MessageHeader
        userId="(Jeditwo)"
        displayNick="Jeditwo"
        bridgedVia="web"
        originalLine="(Jeditwo)"
        timestamp={new Date()}
        theme="discord"
      />,
    );
    const nick = screen.getByText("Jeditwo");
    expect(nick).toBeInTheDocument();
    expect(screen.getByText("via web")).toBeInTheDocument();
    expect(nick.closest("span[title]")?.getAttribute("title")).toBe(
      "(Jeditwo)",
    );
  });

  it("shows no marker for an ordinary line", () => {
    render(
      <MessageHeader userId="alice" timestamp={new Date()} theme="discord" />,
    );
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.queryByText(/^via /)).toBeNull();
  });
});
