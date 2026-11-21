import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppErrorBoundary } from "../../src/components/AppErrorBoundary";

function Throws(): React.ReactNode {
  throw new RangeError("Invalid time value");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppErrorBoundary", () => {
  test("a working app renders as it is", () => {
    render(
      <AppErrorBoundary>
        <span>chat</span>
      </AppErrorBoundary>,
    );

    expect(screen.getByText("chat")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a render error shows the recovery screen with the error text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByTestId("app-error-details").textContent).toContain(
      "RangeError: Invalid time value",
    );
  });

  test("Reload reloads the page once, on request only", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });

    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("Copy error details puts the error text on the clipboard", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));

    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(writeText.mock.calls[0][0]).toContain(
      "RangeError: Invalid time value",
    );
  });

  test("a refused clipboard says so and leaves the text on screen to select", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });

    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));

    await waitFor(() =>
      expect(screen.getByText("Copy failed, select to retry")).toBeTruthy(),
    );
    expect(screen.getByTestId("app-error-details").textContent).toContain(
      "Invalid time value",
    );
  });

  test("touch input gets buttons a finger can hit", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));

    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );

    for (const button of screen.getAllByRole("button"))
      expect(button.className).toContain("min-h-11");
  });
});
