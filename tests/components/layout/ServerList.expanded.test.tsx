import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServerList } from "../../../src/components/layout/ServerList";
import useStore from "../../../src/store";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn(() => "linux"),
}));

describe("server list expanded mode", () => {
  beforeEach(() => {
    useStore.setState({ servers: [], bouncers: {} });
  });
  afterEach(() => vi.restoreAllMocks());

  test("collapsed: rail is not expanded and the toggle offers to show names", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <ServerList expanded={false} onToggleExpanded={onToggle} />,
    );
    expect(container.querySelector(".obby-server-rail")).toHaveAttribute(
      "data-expanded",
      "false",
    );
    const toggle = screen.getByRole("button", { name: "Show server names" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("expanded: rail carries data-expanded for custom CSS and offers to collapse", () => {
    const { container } = render(
      <ServerList expanded={true} onToggleExpanded={() => {}} />,
    );
    expect(container.querySelector(".obby-server-rail")).toHaveAttribute(
      "data-expanded",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Collapse server names" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

describe("AppLayout remembers the expanded preference", () => {
  // tests/setup.ts replaces localStorage with vi.fn() stubs that store nothing.
  const getItem = localStorage.getItem as unknown as ReturnType<typeof vi.fn>;
  const setItem = localStorage.setItem as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getItem.mockReset();
    setItem.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  async function renderLayout() {
    const { BrowserRouter } = await import("react-router-dom");
    const { AppLayout } = await import(
      "../../../src/components/layout/AppLayout"
    );
    useStore.setState({ servers: [], bouncers: {} });
    return render(
      <BrowserRouter>
        <AppLayout />
      </BrowserRouter>,
    );
  }

  test("starts collapsed when nothing is saved", async () => {
    getItem.mockReturnValue(null);
    const { container } = await renderLayout();
    expect(container.querySelector(".obby-server-rail")).toHaveAttribute(
      "data-expanded",
      "false",
    );
  });

  test("starts expanded when the user turned it on before, and saves a toggle", async () => {
    getItem.mockImplementation((key: string) =>
      key === "obby-server-names-expanded" ? "true" : null,
    );
    const { container } = await renderLayout();
    expect(container.querySelector(".obby-server-rail")).toHaveAttribute(
      "data-expanded",
      "true",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse server names" }),
    );
    expect(container.querySelector(".obby-server-rail")).toHaveAttribute(
      "data-expanded",
      "false",
    );
    expect(setItem).toHaveBeenCalledWith("obby-server-names-expanded", "false");
  });
});
