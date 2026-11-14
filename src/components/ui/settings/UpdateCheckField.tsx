import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useState } from "react";
import { useIsTouchInput } from "../../../hooks/useIsTouchInput";
import type { SettingComponentProps } from "../../../lib/settings/types";
import { useAppUpdate } from "../../../store/appUpdate";

type Result = "idle" | "upToDate" | "failed";

/** Asks now instead of waiting for the daily check, and says what it found. */
export const UpdateCheckField: React.FC<SettingComponentProps> = ({
  disabled,
}) => {
  const isChecking = useAppUpdate((s) => s.isChecking);
  const latest = useAppUpdate((s) => s.latest);
  const [result, setResult] = useState<Result>("idle");
  const isTouch = useIsTouchInput();

  const handleCheck = async () => {
    await useAppUpdate.getState().check({ force: true });
    setResult(useAppUpdate.getState().checkFailed ? "failed" : "upToDate");
  };

  // A release found earlier is on offer here as well, so nobody has to leave
  // the page to act on it.
  const version = latest?.version ?? "";
  const button = `rounded px-3 py-1.5 text-sm disabled:opacity-50 text-discord-text-normal ${isTouch ? "min-h-11" : ""}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span
        className="min-w-0 text-sm text-discord-text-muted"
        aria-live="polite"
      >
        {result === "failed" ? (
          <Trans>Could not check. Try again later.</Trans>
        ) : latest ? (
          <Trans>Obby {version} is available.</Trans>
        ) : (
          result === "upToDate" && <Trans>Obby is up to date.</Trans>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {latest && (
          <button
            type="button"
            onClick={() => useAppUpdate.getState().openSheet()}
            disabled={disabled}
            className={`${button} bg-discord-green font-semibold text-white hover:opacity-90`}
          >
            <Trans>Update</Trans>
          </button>
        )}
        <button
          type="button"
          onClick={handleCheck}
          disabled={disabled || isChecking}
          className={`${button} bg-discord-dark-400 hover:bg-discord-dark-300`}
        >
          <Trans>Check now</Trans>
        </button>
      </span>
    </div>
  );
};
