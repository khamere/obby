import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useEffect } from "react";
import { APP_VERSION } from "../../lib/appVersion";
import { shortReleaseLabel } from "../../lib/releaseCheck";
import useStore from "../../store";
import { useAppUpdate } from "../../store/appUpdate";

/** The running version, always visible above the user panel, with a pill
 *  when a newer release exists. The pill never shrinks and never wraps: the
 *  version text gives way first, so nothing else on the row moves. */
export const UpdateLine: React.FC = () => {
  const checkForReleases = useStore(
    (s) => s.globalSettings.checkForReleases !== false,
  );
  const latest = useAppUpdate((s) => s.latest);
  const phase = useAppUpdate((s) => s.phase);
  const received = useAppUpdate((s) => s.received);
  const total = useAppUpdate((s) => s.total);
  const openSheet = useAppUpdate((s) => s.openSheet);

  // The daily cache keeps repeat checks cheap, so coming back to the app is
  // a fine moment to ask again.
  useEffect(() => {
    if (!checkForReleases) return;
    void useAppUpdate.getState().check();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void useAppUpdate.getState().check();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [checkForReleases]);

  const showPill = checkForReleases && latest !== null;
  const downloading = phase === "downloading" && total > 0;
  const percent = Math.min(100, Math.floor((received / total) * 100));
  const label = latest ? shortReleaseLabel(latest.version) : "";

  return (
    <div className="update-line mx-2 h-5 flex items-center gap-1.5 px-1">
      <span className="row-meta min-w-0 flex-1 truncate text-xs select-text">
        Obby {APP_VERSION}
        {__APP_COMMIT__ && ` · ${__APP_COMMIT__}`}
      </span>
      {showPill && (
        <button
          type="button"
          onClick={openSheet}
          aria-label={t`Update Obby to ${label}`}
          className="relative shrink-0 whitespace-nowrap bg-discord-green text-white rounded-full px-2 text-[11px] font-semibold leading-4 after:absolute after:-inset-3 after:content-[''] after:hidden [@media(pointer:coarse)]:after:block"
        >
          {downloading ? (
            <span>↓ {percent}%</span>
          ) : (
            <>
              <span className="update-line-wide">
                <Trans>↑ Update to {label}</Trans>
              </span>
              <span className="update-line-narrow">
                <Trans>↑ Update</Trans>
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
};
