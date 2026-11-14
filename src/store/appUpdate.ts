import { create } from "zustand";
import {
  allowedUpdateHosts,
  cancelDownload,
  downloadStatus,
  type NativeUpdateEvent,
  onUpdateEvent,
  openInstallSettings,
  retryInstall,
  startDownload,
  type UpdateError,
  type UpdatePhase,
} from "../lib/appUpdateNative";
import { isTauriAndroid } from "../lib/platformUtils";
import { type LatestRelease, newerRelease } from "../lib/releaseCheck";

interface AppUpdateState {
  latest: LatestRelease | null;
  isOpen: boolean;
  phase: UpdatePhase;
  received: number;
  total: number;
  error: UpdateError | null;
  isChecking: boolean;
  /** The last check got no answer, so `latest` is what we knew before it. */
  checkFailed: boolean;
  check: (opts?: { force?: boolean }) => Promise<void>;
  openSheet: () => void;
  closeSheet: () => void;
  startUpdate: () => Promise<void>;
  cancelUpdate: () => Promise<void>;
  continueAfterPermission: () => Promise<void>;
  retry: () => Promise<void>;
  applyNative: (e: NativeUpdateEvent) => void;
}

const BUSY: UpdatePhase[] = ["downloading", "verifying", "installing"];

/** A rejected call carries the plugin's code when it sent one. */
function errorCode(e: unknown): UpdateError {
  const text = typeof e === "string" ? e : ((e as Error)?.message ?? "");
  const codes: UpdateError[] = [
    "network",
    "no-apk",
    "checksum",
    "incompatible",
    "refused",
    "storage",
  ];
  return codes.find((c) => c === text) ?? "network";
}

export const useAppUpdate = create<AppUpdateState>((set, get) => {
  // The download belongs to the app, not to the sheet, so we listen once and
  // ask what is already running instead of assuming nothing is.
  let nativeReady: Promise<void> | null = null;
  const ensureNative = (): Promise<void> => {
    if (!isTauriAndroid()) return Promise.resolve();
    nativeReady ??= (async () => {
      try {
        await onUpdateEvent((e) => get().applyNative(e));
        get().applyNative(await downloadStatus());
      } catch {
        nativeReady = null;
      }
    })();
    return nativeReady;
  };

  const fail = (error: UpdateError) =>
    set({ phase: "error", error, received: 0, total: 0 });

  return {
    latest: null,
    isOpen: false,
    phase: "idle",
    received: 0,
    total: 0,
    error: null,
    isChecking: false,
    checkFailed: false,

    check: async (opts) => {
      if (get().isChecking) return;
      set({ isChecking: true });
      try {
        await ensureNative();
        const latest = await newerRelease({ force: opts?.force });
        // The sheet and the pill show the release being downloaded or
        // installed, so we swap it only while nothing is under way.
        set(
          get().phase === "idle"
            ? { latest, checkFailed: false }
            : { checkFailed: false },
        );
      } catch {
        set({ checkFailed: true });
      } finally {
        set({ isChecking: false });
      }
    },

    openSheet: () => {
      set({ isOpen: true });
      void ensureNative();
    },

    // Closing the sheet leaves a running download alone.
    closeSheet: () => set({ isOpen: false }),

    startUpdate: async () => {
      const { latest, phase } = get();
      if (!isTauriAndroid() || !latest || BUSY.includes(phase)) return;
      if (!latest.apk) {
        fail("no-apk");
        return;
      }
      const { url, sha256, size } = latest.apk;
      // Set before the first await so a second tap finds the download started.
      set({ phase: "downloading", received: 0, total: size, error: null });
      try {
        get().applyNative(
          await startDownload({
            url,
            sha256,
            size,
            version: latest.version,
            allowedHosts: allowedUpdateHosts(),
          }),
        );
      } catch (e) {
        fail(errorCode(e));
      }
    },

    cancelUpdate: async () => {
      if (!isTauriAndroid()) return;
      try {
        await cancelDownload();
      } catch {
        // nothing left to cancel
      }
      set({ phase: "idle", received: 0, total: 0, error: null });
    },

    continueAfterPermission: async () => {
      if (!isTauriAndroid()) return;
      try {
        await openInstallSettings();
      } catch (e) {
        fail(errorCode(e));
      }
    },

    retry: async () => {
      if (!isTauriAndroid()) return;
      if (get().error === "refused") {
        try {
          get().applyNative(await retryInstall());
        } catch (e) {
          fail(errorCode(e));
        }
        return;
      }
      // The part file is kept, so this resumes rather than starts over.
      set({ phase: "idle", error: null });
      await get().startUpdate();
    },

    applyNative: (e) =>
      set({
        phase: e.phase,
        received: e.received,
        total: e.total,
        error: e.error,
      }),
  };
});

export const selectCanInstallInApp = (state: AppUpdateState): boolean =>
  isTauriAndroid() && !!state.latest?.apk;
