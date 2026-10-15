import { useLingui } from "@lingui/react/macro";
import type React from "react";
import { useRef, useState } from "react";
import type { SettingComponentProps } from "../../../lib/settings/types";
import {
  parseThemeJson,
  resolveTheme,
  serializeTheme,
  THEME_TOKENS,
  type ThemeToken,
} from "../../../lib/theme";
import { useThemeLinkState } from "../../../lib/themeLink";
import useStore from "../../../store";

const buttonClass =
  "rounded px-3 py-1.5 text-sm bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-500 disabled:opacity-50";

/**
 * Advanced theme editor. Edits the user's own theme (stored as JSON in
 * globalSettings.customTheme); pick "Custom" in the theme list to use it.
 * Export writes the JSON, import reads one (validated: colours only).
 */
export const ThemeEditorField: React.FC<SettingComponentProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const settings = useStore((s) => s.globalSettings);
  const linked = useThemeLinkState().theme;
  const current = parseThemeJson(typeof value === "string" ? value : "");

  const labels: Record<ThemeToken, string> = {
    primary: t`Accent`,
    green: t`Green`,
    yellow: t`Yellow`,
    fuchsia: t`Pink`,
    red: t`Red`,
    "bg-input": t`Input background`,
    "bg-base": t`Chat background`,
    "bg-sidebar": t`Sidebar background`,
    "bg-deep": t`Deep background`,
    icon: t`Icons and borders`,
    "bg-member": t`Member list background`,
    "bg-hover": t`Message hover`,
    fg: t`Text`,
    "fg-muted": t`Muted text`,
    link: t`Links`,
    "fg-channel": t`Channel names`,
    "fg-channel-active": t`Active channel name`,
    success: t`Success`,
    "success-hover": t`Success hover`,
    "button-secondary": t`Secondary buttons`,
    reply: t`Reply accent`,
    "text-strong": t`Strong text`,
    "text-soft": t`Soft text`,
    "text-dim": t`Dim text`,
    "text-faint": t`Faint text`,
    "surface-raised": t`Raised surface`,
    "surface-hover": t`Raised surface hover`,
    "surface-sunken": t`Sunken surface`,
  };

  const startFromCurrent = () => {
    const base = resolveTheme(settings, linked);
    onChange(
      serializeTheme({
        ...base,
        id: "custom",
        name: base.id === "custom" ? base.name : `${base.name} (edited)`,
      }),
    );
    setOpen(true);
  };

  const setColor = (token: ThemeToken, hex: string) => {
    if (!current) return;
    onChange(
      serializeTheme({
        ...current,
        colors: { ...current.colors, [token]: hex },
      }),
    );
  };

  const exportTheme = () => {
    if (!current) return;
    const blob = new Blob([serializeTheme(current)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${current.name.replace(/[^\w-]+/g, "-").toLowerCase() || "theme"}.obby-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importTheme = async (file: File) => {
    const parsed = parseThemeJson(await file.text());
    if (!parsed) {
      setMessage(t`That file is not an Obby theme.`);
      return;
    }
    setMessage(null);
    onChange(serializeTheme({ ...parsed, id: "custom" }));
    setOpen(true);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={disabled}
          onClick={startFromCurrent}
        >
          {current
            ? t`Reset to the current theme`
            : t`Start from the current theme`}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          {t`Import…`}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={disabled || !current}
          onClick={exportTheme}
        >
          {t`Export`}
        </button>
        {current && (
          <button
            type="button"
            className={buttonClass}
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t`Hide colours` : t`Edit colours`}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importTheme(f);
            e.target.value = "";
          }}
        />
      </div>
      {message && <div className="text-sm text-discord-red">{message}</div>}
      {current && open && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-discord-text-normal">
            <span className="w-40">{t`Theme name`}</span>
            <input
              type="text"
              value={current.name}
              maxLength={60}
              disabled={disabled}
              onChange={(e) =>
                onChange(serializeTheme({ ...current, name: e.target.value }))
              }
              className="flex-1 bg-discord-dark-400 text-discord-text-normal rounded px-2 py-1"
            />
          </label>
          <div
            className="grid gap-x-4 gap-y-1"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            }}
          >
            {THEME_TOKENS.map((token) => (
              <label
                key={token}
                className="flex items-center gap-2 text-sm text-discord-text-normal"
              >
                <input
                  type="color"
                  value={current.colors[token]}
                  disabled={disabled}
                  onChange={(e) => setColor(token, e.target.value)}
                  className="w-8 h-6 rounded border-none bg-transparent cursor-pointer"
                />
                <span>{labels[token]}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
