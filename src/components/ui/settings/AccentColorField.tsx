import { useLingui } from "@lingui/react/macro";
import type React from "react";
import type { SettingComponentProps } from "../../../lib/settings/types";
import { isHexColor } from "../../../lib/theme";

const SWATCHES = [
  "#5865f2",
  "#3b82f6",
  "#06b6d4",
  "#10b981",
  "#84cc16",
  "#f59e0b",
  "#f97316",
  "#ef4444",
  "#ec4899",
  "#a855f7",
];

/**
 * Accent colour: empty means "use the theme's own accent"; otherwise a hex
 * colour that replaces the primary token (buttons, selection, mention pills).
 */
export const AccentColorField: React.FC<SettingComponentProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const { t } = useLingui();
  const current = typeof value === "string" ? value : "";
  const useTheme = !isHexColor(current);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 cursor-pointer text-discord-text-normal">
        <input
          type="checkbox"
          checked={useTheme}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? "" : SWATCHES[0])}
          className="accent-discord-primary"
        />
        <span>{t`Use the theme's accent colour`}</span>
      </label>
      {!useTheme && (
        <div className="flex items-center gap-2 flex-wrap">
          {SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={hex}
              disabled={disabled}
              onClick={() => onChange(hex)}
              className={`w-7 h-7 rounded-full border-2 ${
                current.toLowerCase() === hex
                  ? "border-white"
                  : "border-transparent"
              }`}
              style={{ background: hex }}
            />
          ))}
          <input
            type="color"
            value={current}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            aria-label={t`Custom accent colour`}
            className="w-9 h-7 rounded border-none cursor-pointer bg-transparent"
          />
        </div>
      )}
    </div>
  );
};
