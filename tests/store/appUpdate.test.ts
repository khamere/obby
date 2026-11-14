import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeUpdateEvent } from "../../src/lib/appUpdateNative";

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

type Store = typeof import("../../src/store/appUpdate").useAppUpdate;
let useAppUpdate: Store;

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
const idle: NativeUpdateEvent = {
  phase: "idle",
  received: 0,
  total: 0,
  error: null,
};

// The store asks the plugin what is under way before it acts, so a scenario
// puts its starting point in both places.
function underWay(patch: Partial<NativeUpdateEvent>) {
  const status = { ...idle, ...patch };
  native.downloadStatus.mockResolvedValue(status);
  useAppUpdate.setState(status);
}

beforeEach(async () => {
  vi.clearAllMocks();
  // The store keeps its plugin listener for the life of the module, so each
  // test gets a module of its own and passes when run alone.
  vi.resetModules();
  ({ useAppUpdate } = await import("../../src/store/appUpdate"));
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
    underWay({ phase: "downloading", received: 10, total: 100 });
    releases.newerRelease.mockResolvedValueOnce(null);
    await useAppUpdate.getState().check();
    expect(useAppUpdate.getState().latest).toEqual(release);
  });

  // A release republished after a bad upload has a new checksum, and the
  // next attempt must be measured against that one.
  it("a check after a failed update takes the corrected release and clears the error", async () => {
    underWay({ phase: "error", error: "checksum" });
    const corrected = { ...release, apk: { ...apk, sha256: "cd".repeat(32) } };
    releases.newerRelease.mockResolvedValueOnce(corrected);
    await useAppUpdate.getState().check({ force: true });
    const state = useAppUpdate.getState();
    expect(state.latest).toEqual(corrected);
    expect(state.phase).toBe("idle");
    expect(state.error).toBeNull();

    await state.startUpdate();
    expect(native.startDownload).toHaveBeenCalledWith(
      expect.objectContaining({ sha256: "cd".repeat(32) }),
    );
  });

  it("a check after a failed update keeps the error when the release is the same", async () => {
    underWay({ phase: "error", error: "network" });
    releases.newerRelease.mockResolvedValueOnce({
      ...release,
      apk: { ...apk },
    });
    await useAppUpdate.getState().check({ force: true });
    expect(useAppUpdate.getState().phase).toBe("error");
    expect(useAppUpdate.getState().error).toBe("network");
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

  it("startUpdate listens to the plugin before it asks for the download", async () => {
    const order: string[] = [];
    native.onUpdateEvent.mockImplementation(async () => {
      order.push("listen");
      return {};
    });
    native.startDownload.mockImplementation(async () => {
      order.push("download");
      return { phase: "downloading", received: 0, total: 100, error: null };
    });
    await useAppUpdate.getState().startUpdate();
    expect(order).toEqual(["listen", "download"]);
  });

  it("startUpdate stops when the plugin cannot be heard, and a retry starts it", async () => {
    native.onUpdateEvent.mockRejectedValueOnce(new Error("no plugin"));
    await useAppUpdate.getState().startUpdate();
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(useAppUpdate.getState()).toMatchObject({
      phase: "error",
      error: "not-ready",
    });
    await useAppUpdate.getState().retry();
    expect(native.onUpdateEvent).toHaveBeenCalledTimes(2);
    expect(native.startDownload).toHaveBeenCalledTimes(1);
    expect(useAppUpdate.getState().phase).toBe("downloading");
  });

  it("startUpdate keeps its one listener when the plugin's status fails, and a retry starts it", async () => {
    native.downloadStatus.mockRejectedValueOnce(new Error("no answer"));
    await useAppUpdate.getState().startUpdate();
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(useAppUpdate.getState()).toMatchObject({
      phase: "error",
      error: "not-ready",
    });
    await useAppUpdate.getState().retry();
    expect(native.onUpdateEvent).toHaveBeenCalledTimes(1);
    expect(native.downloadStatus).toHaveBeenCalledTimes(2);
    expect(native.startDownload).toHaveBeenCalledTimes(1);
    expect(useAppUpdate.getState().phase).toBe("downloading");
  });

  it.each([
    ["is heard", true],
    ["cannot be heard", false],
  ])(
    "a cancel while the plugin is being reached stays cancelled when it %s",
    async (_, heard) => {
      let settle = () => {};
      native.onUpdateEvent.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          settle = () => (heard ? resolve({}) : reject(new Error("no plugin")));
        }),
      );
      const starting = useAppUpdate.getState().startUpdate();
      expect(useAppUpdate.getState().phase).toBe("downloading");
      await useAppUpdate.getState().cancelUpdate();
      settle();
      await starting;
      expect(native.startDownload).not.toHaveBeenCalled();
      expect(useAppUpdate.getState()).toMatchObject({
        phase: "idle",
        error: null,
      });
    },
  );

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
    const installing: NativeUpdateEvent = {
      phase: "installing",
      received: 100,
      total: 100,
      error: null,
    };
    native.retryInstall.mockResolvedValueOnce(installing);
    underWay(installing);
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
    underWay({ phase: "installing", received: 100, total: 100 });
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
    underWay({ phase: "error", error: "refused" });
    await useAppUpdate.getState().retry();
    expect(native.retryInstall).toHaveBeenCalledTimes(1);
    underWay({ phase: "error", error: "network" });
    await useAppUpdate.getState().retry();
    expect(native.startDownload).toHaveBeenCalledTimes(1);
  });
});
