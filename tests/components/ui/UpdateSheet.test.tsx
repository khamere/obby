import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ android: true, touch: false }));
vi.mock("../../../src/lib/platformUtils", async (orig) => ({
  ...(await orig<object>()),
  isTauriAndroid: () => env.android,
}));
vi.mock("../../../src/hooks/useIsTouchInput", () => ({
  useIsTouchInput: () => env.touch,
}));
vi.mock("../../../src/lib/appVersion", () => ({
  APP_VERSION: "0.4.0-cf1.2.0",
}));
vi.mock("../../../src/components/ui/ExternalLinkWarningModal", () => ({
  default: ({ isOpen, url }: { isOpen: boolean; url: string }) =>
    isOpen ? <div data-testid="link-warning">{url}</div> : null,
}));

import UpdateSheet from "../../../src/components/ui/UpdateSheet";
import { useAppUpdate } from "../../../src/store/appUpdate";

const MB = 1024 * 1024;
const release = {
  version: "0.4.0-cf1.2.1",
  url: "https://github.com/r/releases/1",
  notes: "Fixed the thing",
  apk: {
    name: "obby.apk",
    size: 79 * MB,
    sha256: "a".repeat(64),
    url: "https://github.com/r/obby.apk",
  },
};

const fns = {
  startUpdate: vi.fn(async () => {}),
  cancelUpdate: vi.fn(async () => {}),
  continueAfterPermission: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
  showInstallPrompt: vi.fn(async () => {}),
  closeSheet: vi.fn(),
};

function seed(patch: Record<string, unknown> = {}) {
  act(() => {
    useAppUpdate.setState({
      latest: release,
      isOpen: true,
      phase: "idle",
      received: 0,
      total: 0,
      error: null,
      ...fns,
      ...patch,
    } as never);
  });
}

beforeEach(() => {
  env.android = true;
  env.touch = false;
  for (const f of Object.values(fns)) f.mockClear();
  seed();
});

describe("UpdateSheet", () => {
  it("offers the update with size and notes", () => {
    render(<UpdateSheet />);
    expect(screen.getByText(/79 MB download/)).toBeTruthy();
    const box = screen.getByRole("region", { name: "Release notes" });
    expect(box.textContent).toContain("Fixed the thing");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(fns.startUpdate).toHaveBeenCalled();
  });

  it("outside Android, Download opens the release page through the link warning", () => {
    env.android = false;
    render(<UpdateSheet />);
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByTestId("link-warning").textContent).toBe(release.url);
  });

  it("shows progress and cancels", () => {
    seed({ phase: "downloading", received: 36 * MB, total: 79 * MB });
    render(<UpdateSheet />);
    expect(screen.getByText("36 of 79 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "46",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fns.cancelUpdate).toHaveBeenCalled();
  });

  it("asks for the install permission and opens the setting", () => {
    seed({ phase: "needs-permission" });
    render(<UpdateSheet />);
    expect(screen.getByText("Allow Obby to install updates")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Android settings" }),
    );
    expect(fns.continueAfterPermission).toHaveBeenCalled();
  });

  it("while Android's prompt is open, offers to show it again or to cancel", () => {
    seed({ phase: "installing", received: 79 * MB, total: 79 * MB });
    render(<UpdateSheet />);
    fireEvent.click(
      screen.getByRole("button", { name: "Show the install prompt again" }),
    );
    expect(fns.showInstallPrompt).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fns.cancelUpdate).toHaveBeenCalledTimes(1);
  });

  const messages: [string, string][] = [
    ["network", "The download stopped. Check your connection and try again."],
    ["no-apk", "This release has no Android app to install."],
    [
      "checksum",
      "The download did not match the release's checksum, so it was thrown away.",
    ],
    [
      "incompatible",
      "Android refused the update because it was signed by someone else. Install it from the release page.",
    ],
    ["refused", "The install was cancelled."],
    ["storage", "There is not enough free space for the update."],
    ["not-ready", "The update could not start. Try again."],
  ];
  it.each(messages)("explains the %s error", (code, text) => {
    seed({ phase: "error", error: code });
    render(<UpdateSheet />);
    expect(screen.getByText("Update not installed")).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fns.retry).toHaveBeenCalled();
  });

  it("is a bottom sheet on touch input and a dialog with a mouse", () => {
    env.touch = true;
    const { unmount } = render(<UpdateSheet />);
    expect(document.querySelector(".surface-sheet")).toBeTruthy();
    unmount();
    env.touch = false;
    render(<UpdateSheet />);
    expect(document.querySelector(".surface-sheet")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
