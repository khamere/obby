import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ touch: false }));
vi.mock("../../../../src/hooks/useIsTouchInput", () => ({
  useIsTouchInput: () => env.touch,
}));
vi.mock("../../../../src/lib/releaseCheck", () => ({
  newerRelease: vi.fn(),
}));

import { UpdateCheckField } from "../../../../src/components/ui/settings/UpdateCheckField";
import { useAppUpdate } from "../../../../src/store/appUpdate";

const release = {
  version: "0.4.0-cf1.2.1",
  url: "https://github.com/r",
  notes: "",
  apk: null,
};

// The field reads nothing from its setting, so the props only fill the type.
const props = { value: null, onChange: () => {} } as unknown as Parameters<
  typeof UpdateCheckField
>[0];

function seed(after: Record<string, unknown>) {
  const check = vi.fn(async () => {
    useAppUpdate.setState(after as never);
  });
  act(() => {
    useAppUpdate.setState({
      latest: null,
      isChecking: false,
      checkFailed: false,
      check,
    } as never);
  });
  return check;
}

async function checkNow() {
  render(<UpdateCheckField {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
  });
}

describe("UpdateCheckField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.touch = false;
  });

  it("gives both buttons a finger-sized height on touch input only", () => {
    seed({});
    act(() => useAppUpdate.setState({ latest: release } as never));
    const { unmount } = render(<UpdateCheckField {...props} />);
    for (const b of screen.getAllByRole("button")) {
      expect(b.className).not.toContain("min-h-11");
    }
    unmount();
    env.touch = true;
    render(<UpdateCheckField {...props} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b.className).toContain("min-h-11");
  });

  it("forces a check and says when nothing is newer", async () => {
    const check = seed({ latest: null });
    await checkNow();
    expect(check).toHaveBeenCalledWith({ force: true });
    expect(screen.getByText("Obby is up to date.")).toBeTruthy();
  });

  it("names the release it found", async () => {
    seed({ latest: release });
    await checkNow();
    expect(screen.getByText("Obby 0.4.0-cf1.2.1 is available.")).toBeTruthy();
  });

  it("offers the update right there once one is known", async () => {
    seed({ latest: release });
    const openSheet = vi.fn();
    act(() => useAppUpdate.setState({ openSheet } as never));
    await checkNow();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(openSheet).toHaveBeenCalledTimes(1);
  });

  it("offers a known update before anyone taps Check now", () => {
    seed({});
    act(() => useAppUpdate.setState({ latest: release } as never));
    render(<UpdateCheckField {...props} />);
    expect(screen.getByText("Obby 0.4.0-cf1.2.1 is available.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("offers no update when Obby is up to date", async () => {
    seed({ latest: null });
    await checkNow();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("says the check failed instead of calling Obby up to date", async () => {
    seed({ latest: null, checkFailed: true });
    await checkNow();
    expect(screen.getByText("Could not check. Try again later.")).toBeTruthy();
    expect(screen.queryByText("Obby is up to date.")).toBeNull();
  });
});
