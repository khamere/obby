import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useState } from "react";
import type { SettingComponentProps } from "../../../lib/settings/types";
import { useAppUpdate } from "../../../store/appUpdate";

type Result = "idle" | "upToDate" | "available";

/** Asks now instead of waiting for the daily check, and says what it found. */
export const UpdateCheckField: React.FC<SettingComponentProps> = ({
  disabled,
}) => {
  const isChecking = useAppUpdate((s) => s.isChecking);
  const latest = useAppUpdate((s) => s.latest);
  const [result, setResult] = useState<Result>("idle");

  const handleCheck = async () => {
    await useAppUpdate.getState().check({ force: true });
    setResult(useAppUpdate.getState().latest ? "available" : "upToDate");
  };

  const version = latest?.version ?? "";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-discord-text-muted" aria-live="polite">
        {result === "upToDate" && <Trans>Obby is up to date.</Trans>}
        {result === "available" && <Trans>Obby {version} is available.</Trans>}
      </span>
      <button
        type="button"
        onClick={handleCheck}
        disabled={disabled || isChecking}
        className="rounded px-3 py-1.5 text-sm disabled:opacity-50 bg-discord-dark-400 hover:bg-discord-dark-300 text-discord-text-normal"
      >
        <Trans>Check now</Trans>
      </button>
    </div>
  );
};
