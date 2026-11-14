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
  showInstallPrompt: () => Promise<void>;
  applyNative: (e: NativeUpdateEvent) => void;
}

const BUSY: UpdatePhase[] = ["downloading", "verifying", "installing"];

const NOTHING_UNDER_WAY = {
  phase: "idle",
  error: null,
  received: 0,
  total: 0,
} as const;

function isSameRelease(
  a: LatestRelease | null,
  b: LatestRelease | null,
): boolean {
  return (
    a?.version === b?.version &&
    a?.apk?.sha256 === b?.apk?.sha256 &&
    a?.apk?.url === b?.apk?.url
  );
}

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
  // It answers whether we hear the plugin, and a failure is forgotten so the
  // next caller tries again.
  let nativeReady: Promise<boolean> | null = null;
  // The listener outlives a failed status request, so the next try reuses it
  // instead of adding one that would apply every event a second time.
  let listening: Promise<unknown> | null = null;
  const listen = (): Promise<unknown> => {
    listening ??= onUpdateEvent((e) => get().applyNative(e)).catch((e) => {
      listening = null;
      throw e;
    });
    return listening;
  };
  const ensureNative = (): Promise<boolean> => {
    if (!isTauriAndroid()) return Promise.resolve(false);
    nativeReady ??= (async () => {
      try {
        await listen();
        get().applyNative(await downloadStatus());
        return true;
      } catch {
        nativeReady = null;
        return false;
      }
    })();
    return nativeReady;
  };

  // Counts starts and cancels. A start waits on the plugin more than once,
  // and the phase alone cannot tell a cancel from the plugin's first status.
  let attempt = 0;

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
        const { phase, latest: known } = get();
        if (phase === "idle") {
          set({ latest, checkFailed: false });
        } else if (phase === "error") {
          // A failed attempt is over, so we take the answer; a release that
          // changed (a republished file has a new checksum) starts afresh.
          set(
            isSameRelease(known, latest)
              ? { latest, checkFailed: false }
              : { latest, checkFailed: false, ...NOTHING_UNDER_WAY },
          );
        } else {
          // The sheet and the pill show the release being downloaded or
          // installed, so we leave it alone while that is under way.
          set({ checkFailed: false });
        }
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
      const started = () =>
        set({ phase: "downloading", received: 0, total: size, error: null });
      started();
      attempt += 1;
      const mine = attempt;
      // Progress, the permission request and errors only reach us through
      // the listener, so a download nobody hears would leave the sheet stuck.
      const heard = await ensureNative();
      if (mine !== attempt) return;
      if (!heard) {
        fail("not-ready");
        return;
      }
      // Listening for the first time also brings the plugin's own status.
      if (!BUSY.includes(get().phase)) started();
      try {
        const status = await startDownload({
          url,
          sha256,
          size,
          version: latest.version,
          allowedHosts: allowedUpdateHosts(),
        });
        if (mine === attempt) get().applyNative(status);
      } catch (e) {
        if (mine === attempt) fail(errorCode(e));
      }
    },

    cancelUpdate: async () => {
      if (!isTauriAndroid()) return;
      attempt += 1;
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
        await get().showInstallPrompt();
        return;
      }
      // The part file is kept, so this resumes rather than starts over.
      set({ phase: "idle", error: null });
      await get().startUpdate();
    },

    // Android's prompt lives outside the app and can be left behind, so
    // the plugin brings it back for the file it already verified.
    showInstallPrompt: async () => {
      if (!isTauriAndroid()) return;
      try {
        get().applyNative(await retryInstall());
      } catch (e) {
        fail(errorCode(e));
      }
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
