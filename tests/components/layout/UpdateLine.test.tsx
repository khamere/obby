import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ checkForReleases: true }));
vi.mock("../../../src/store", () => ({
  default: (sel: (s: unknown) => unknown) =>
    sel({ globalSettings: { checkForReleases: settings.checkForReleases } }),
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

  it("the pill never shrinks and the version gives way first", () => {
    setState({ latest: release });
    render(<UpdateLine />);
    const pill = screen.getByRole("button");
    expect(pill.className).toContain("shrink-0");
    expect(pill.className).toContain("whitespace-nowrap");
    const version = screen.getByText(/Obby 0\.4\.0/);
    expect(version.className).toContain("min-w-0");
    expect(version.className).toContain("truncate");
  });
});
