import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ checkForReleases: true }));
vi.mock("../../../src/store", () => ({
  default: (sel: (s: unknown) => unknown) =>
    sel({ globalSettings: { checkForReleases: settings.checkForReleases } }),
}));
const env = vi.hoisted(() => ({ touch: false }));
vi.mock("../../../src/hooks/useIsTouchInput", () => ({
  useIsTouchInput: () => env.touch,
}));
vi.mock("../../../src/lib/appVersion", () => ({
  APP_VERSION: "0.4.0-cf1.2.0",
}));
vi.mock("../../../src/lib/releaseCheck", () => ({
  shortReleaseLabel: (v: string) => v.replace(/^\d+\.\d+\.\d+-/, ""),
  newerRelease: vi.fn(),
}));

import { UpdateLine } from "../../../src/components/layout/UpdateLine";
import { useAppUpdate } from "../../../src/store/appUpdate";

const release = {
  version: "0.4.0-cf1.2.1",
  url: "https://github.com/r",
  notes: "",
  apk: null,
};

function setState(patch: Record<string, unknown>) {
  act(() => {
    useAppUpdate.setState({
      latest: null,
      phase: "idle",
      received: 0,
      total: 0,
      isOpen: false,
      check: vi.fn(async () => {}),
      ...patch,
    } as never);
  });
}

beforeEach(() => {
  settings.checkForReleases = true;
  vi.stubGlobal("__APP_COMMIT__", "abc1234");
  setState({});
});

describe("UpdateLine", () => {
  it("always shows the version", () => {
    render(<UpdateLine />);
    expect(screen.getByText(/Obby 0\.4\.0-cf1\.2\.0 · abc1234/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the pill only when a newer release exists", () => {
    setState({ latest: release });
    render(<UpdateLine />);
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("hides the pill when checkForReleases is off", () => {
    settings.checkForReleases = false;
    const check = vi.fn(async () => {});
    setState({ latest: release, check });
    render(<UpdateLine />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("labels the pill with the release", () => {
    setState({ latest: release });
    const { unmount } = render(<UpdateLine />);
    expect(screen.getByText("↑ Update to cf1.2.1")).toBeTruthy();
    expect(screen.getByText("↑ Update")).toBeTruthy();
    unmount();
    setState({
      latest: release,
      phase: "downloading",
      received: 46,
      total: 100,
    });
    render(<UpdateLine />);
    expect(screen.getByText("↓ 46%")).toBeTruthy();
  });

  it("tapping the pill opens the popup; the version text does nothing", () => {
    const openSheet = vi.fn();
    setState({ latest: release, openSheet });
    render(<UpdateLine />);
    fireEvent.click(screen.getByText(/Obby 0\.4\.0/));
    expect(openSheet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));
    expect(openSheet).toHaveBeenCalledTimes(1);
  });

  it("checks on mount and when the app becomes visible again", () => {
    const check = vi.fn(async () => {});
    setState({ check });
    render(<UpdateLine />);
    expect(check).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(check).toHaveBeenCalledTimes(2);
  });

  // The pill's text is 16px high and a finger needs 44px. On touch input the
  // row itself grows to 44px while the pill shows, so the touch area stays
  // inside the row and takes nothing from the list above or the user panel
  // below.
  it("the pill takes touches inside its own row on touch input", () => {
    env.touch = true;
    setState({ latest: release });
    const { container } = render(<UpdateLine />);
    const row = container.querySelector(".update-line") as HTMLElement;
    const classes = screen.getByRole("button").className.split(" ");
    expect(row.className.split(" ")).toContain("h-11");
    expect(row.className.split(" ")).not.toContain("h-5");
    expect(classes).toContain("after:-inset-x-3.5");
    expect(classes).toContain("after:-inset-y-3.5");
    env.touch = false;
  });

  it("keeps the row and the pill at their usual size with a mouse", () => {
    env.touch = false;
    setState({ latest: release });
    const { container } = render(<UpdateLine />);
    const row = container.querySelector(".update-line") as HTMLElement;
    const classes = screen.getByRole("button").className;
    expect(row.className.split(" ")).toContain("h-5");
    expect(row.className).not.toContain("h-11");
    expect(classes).not.toContain("after:");
    expect(classes).not.toContain("pointer:coarse");
  });

  it("keeps the row at its usual height on touch input when there is no pill", () => {
    env.touch = true;
    setState({ latest: null });
    const { container } = render(<UpdateLine />);
    const row = container.querySelector(".update-line") as HTMLElement;
    expect(row.className.split(" ")).toContain("h-5");
    expect(row.className).not.toContain("h-11");
    env.touch = false;
  });

  it("the pill never shrinks and the version gives way first", () => {
    setState({ latest: release });
    render(<UpdateLine />);
    const pill = screen.getByRole("button");
    expect(pill.className).toContain("shrink-0");
    expect(pill.className).toContain("whitespace-nowrap");
    const version = screen.getByTitle("Obby 0.4.0-cf1.2.0 · abc1234");
    expect(version.className).toContain("min-w-0");
    expect(version.className).toContain("truncate");
  });

  it("carries the version in three lengths for the row's width to pick from", () => {
    render(<UpdateLine />);
    const version = screen.getByTitle("Obby 0.4.0-cf1.2.0 · abc1234");
    const variants = [...version.children].map((el) => [
      el.className,
      el.textContent,
    ]);
    expect(variants).toEqual([
      ["update-line-full", "Obby 0.4.0-cf1.2.0 · abc1234"],
      ["update-line-version", "0.4.0-cf1.2.0"],
      ["update-line-short", "cf1.2.0"],
    ]);
  });

  it("marks the row when the pill takes part of it", () => {
    const hasMark = (container: HTMLElement) =>
      container
        .querySelector(".update-line")
        ?.classList.contains("update-line-with-pill");
    const alone = render(<UpdateLine />);
    expect(hasMark(alone.container)).toBe(false);
    alone.unmount();
    setState({ latest: release });
    expect(hasMark(render(<UpdateLine />).container)).toBe(true);
  });
});
