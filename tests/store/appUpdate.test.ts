import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  startDownload: vi.fn(),
  cancelDownload: vi.fn(),
  downloadStatus: vi.fn(),
  openInstallSettings: vi.fn(),
  retryInstall: vi.fn(),
  onUpdateEvent: vi.fn(),
  allowedUpdateHosts: vi.fn(() => [
    "github.com",
    ".githubusercontent.com",
    "api.github.com",
  ]),
}));
const releases = vi.hoisted(() => ({ newerRelease: vi.fn() }));
const platform = vi.hoisted(() => ({ isTauriAndroid: vi.fn() }));

vi.mock("../../src/lib/appUpdateNative", () => native);
vi.mock("../../src/lib/releaseCheck", () => releases);
vi.mock("../../src/lib/platformUtils", () => platform);

import { useAppUpdate } from "../../src/store/appUpdate";

const apk = {
  name: "o.apk",
  size: 100,
  sha256: "ab".repeat(32),
  url: "https://github.com/o.apk",
};
const release = {
  version: "0.4.0-cf1.2.0",
  url: "https://github.com/r",
  notes: "",
  apk,
};
const idle = { phase: "idle", received: 0, total: 0, error: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  platform.isTauriAndroid.mockReturnValue(true);
  native.onUpdateEvent.mockResolvedValue({});
  native.downloadStatus.mockResolvedValue(idle);
  native.startDownload.mockResolvedValue({
    phase: "downloading",
    received: 0,
    total: 100,
    error: null,
  });
  useAppUpdate.setState({
    latest: release,
    isOpen: false,
    ...idle,
    isChecking: false,
    checkFailed: false,
  });
});

describe("app update store", () => {
  it("check stores the newer release and nothing when there is none", async () => {
    useAppUpdate.setState({ latest: null });
    releases.newerRelease.mockResolvedValueOnce(release);
    await useAppUpdate.getState().check();
    expect(useAppUpdate.getState().latest).toEqual(release);
    releases.newerRelease.mockResolvedValueOnce(null);
    await useAppUpdate.getState().check();
    expect(useAppUpdate.getState().latest).toBeNull();
  });

  it("a failed check keeps the known release and says it failed", async () => {
    releases.newerRelease.mockRejectedValueOnce(new Error("offline"));
    await useAppUpdate.getState().check({ force: true });
    expect(useAppUpdate.getState()).toMatchObject({
      latest: release,
      checkFailed: true,
      isChecking: false,
    });
    releases.newerRelease.mockResolvedValueOnce(release);
    await useAppUpdate.getState().check({ force: true });
    expect(useAppUpdate.getState().checkFailed).toBe(false);
  });

  it("a check during a download leaves the release being installed alone", async () => {
    useAppUpdate.setState({ phase: "downloading", received: 10, total: 100 });
    releases.newerRelease.mockResolvedValueOnce(null);
    await useAppUpdate.getState().check();
    expect(useAppUpdate.getState().latest).toEqual(release);
  });

  it("startUpdate on Android asks the plugin once, even when tapped twice", async () => {
    const s = useAppUpdate.getState();
    await Promise.all([s.startUpdate(), s.startUpdate()]);
    expect(native.startDownload).toHaveBeenCalledTimes(1);
    expect(native.startDownload).toHaveBeenCalledWith({
      url: apk.url,
      sha256: apk.sha256,
      size: 100,
      version: release.version,
      allowedHosts: ["github.com", ".githubusercontent.com", "api.github.com"],
    });
  });

  it("a release without an APK goes to the no-apk error instead of downloading", async () => {
    useAppUpdate.setState({ latest: { ...release, apk: null } });
    await useAppUpdate.getState().startUpdate();
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(useAppUpdate.getState()).toMatchObject({
      phase: "error",
      error: "no-apk",
    });
  });

  it("closing the sheet keeps the download", async () => {
    await useAppUpdate.getState().startUpdate();
    useAppUpdate.getState().closeSheet();
    expect(native.cancelDownload).not.toHaveBeenCalled();
    expect(useAppUpdate.getState().phase).toBe("downloading");
  });

  it("native events update the progress", () => {
    useAppUpdate.getState().applyNative({
      phase: "downloading",
      received: 10,
      total: 100,
      error: null,
    });
    expect(useAppUpdate.getState()).toMatchObject({
      phase: "downloading",
      received: 10,
      total: 100,
    });
  });

  it("outside Android, startUpdate does not touch the plugin", async () => {
    platform.isTauriAndroid.mockReturnValue(false);
    await useAppUpdate.getState().startUpdate();
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(useAppUpdate.getState().phase).toBe("idle");
  });

  it("showInstallPrompt asks the plugin for the prompt and takes its status", async () => {
    const installing = {
      phase: "installing",
      received: 100,
      total: 100,
      error: null,
    };
    native.retryInstall.mockResolvedValueOnce(installing);
    useAppUpdate.setState(installing as never);
    await useAppUpdate.getState().showInstallPrompt();
    expect(native.retryInstall).toHaveBeenCalledTimes(1);
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(useAppUpdate.getState().phase).toBe("installing");
    native.retryInstall.mockRejectedValueOnce("storage");
    await useAppUpdate.getState().showInstallPrompt();
    expect(useAppUpdate.getState()).toMatchObject({
      phase: "error",
      error: "storage",
    });
  });

  it("cancelling during the install tells the plugin and returns to idle", async () => {
    useAppUpdate.setState({ phase: "installing", received: 100, total: 100 });
    await useAppUpdate.getState().cancelUpdate();
    expect(native.cancelDownload).toHaveBeenCalledTimes(1);
    expect(useAppUpdate.getState().phase).toBe("idle");
  });

  it("retry reinstalls after a refusal and resumes after any other error", async () => {
    native.retryInstall.mockResolvedValue({
      phase: "installing",
      received: 100,
      total: 100,
      error: null,
    });
    useAppUpdate.setState({ phase: "error", error: "refused" });
    await useAppUpdate.getState().retry();
    expect(native.retryInstall).toHaveBeenCalledTimes(1);
    useAppUpdate.setState({ phase: "error", error: "network" });
    await useAppUpdate.getState().retry();
    expect(native.startDownload).toHaveBeenCalledTimes(1);
  });
});
