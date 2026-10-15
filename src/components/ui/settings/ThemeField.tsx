import { useLingui } from "@lingui/react/macro";
import type React from "react";
import type { SettingComponentProps } from "../../../lib/settings/types";
import {
  BUILT_IN_THEMES,
  CUSTOM_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  getTheme,
  LINK_THEME_ID,
  parseThemeJson,
  SYSTEM_THEME_ID,
  type ThemeDefinition,
} from "../../../lib/theme";
import { useThemeLinkState } from "../../../lib/themeLink";
import useStore from "../../../store";

/**
 * Theme preset picker. Each card is a miniature of the app drawn from the
 * preset's own colours, so the choice can be judged before saving.
 */
export const ThemeField: React.FC<SettingComponentProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const { t } = useLingui();
  const selected = typeof value === "string" ? value : "";
  const customJson = useStore((s) => s.globalSettings.customTheme);
  const linked = useThemeLinkState().theme;
  const custom = parseThemeJson(customJson);
  const themes: ThemeDefinition[] = [
    {
      ...getTheme(DEFAULT_LIGHT_THEME_ID),
      id: SYSTEM_THEME_ID,
      name: t`Follow system (dark / light)`,
    },
    ...BUILT_IN_THEMES,
    ...(custom
      ? [{ ...custom, id: CUSTOM_THEME_ID, name: t`Custom: ${custom.name}` }]
      : []),
    ...(linked
      ? [{ ...linked, id: LINK_THEME_ID, name: t`From link: ${linked.name}` }]
      : []),
  ];
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
    >
      {themes.map((theme) => (
        <ThemeCard
          key={theme.id}
          theme={theme}
          selected={theme.id === selected}
          disabled={disabled}
          onSelect={() => onChange(theme.id)}
        />
      ))}
    </div>
  );
};

const ThemeCard: React.FC<{
  theme: ThemeDefinition;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}> = ({ theme, selected, disabled, onSelect }) => {
  const { t } = useLingui();
  const c = theme.colors;
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      data-theme-id={theme.id}
      className={`text-left rounded-lg overflow-hidden border-2 transition-colors disabled:opacity-50 ${
        selected
          ? "border-discord-primary"
          : "border-transparent hover:border-discord-dark-500"
      }`}
    >
      <div
        className="flex h-20"
        style={{ background: c["bg-base"], color: c.fg }}
        aria-hidden="true"
      >
        <div className="w-5" style={{ background: c["bg-sidebar"] }} />
        <div className="w-10" style={{ background: c["bg-member"] }}>
          <div
            className="mx-1.5 mt-2 h-1.5 rounded"
            style={{ background: c.primary }}
          />
          <div
            className="mx-1.5 mt-1 h-1.5 rounded"
            style={{ background: c["fg-channel"] }}
          />
        </div>
        <div className="flex-1 px-2 py-1.5 text-[10px] leading-tight">
          <div>
            <span className="font-semibold" style={{ color: c.primary }}>
              {t`someone`}
            </span>{" "}
            <span style={{ color: c["fg-muted"] }}>12:34</span>
          </div>
          <div>{t`Sample message`}</div>
          <div style={{ color: c.link }}>https://example.org</div>
          <div
            className="mt-1 h-3 rounded"
            style={{ background: c["bg-input"] }}
          />
        </div>
      </div>
      <div
        className="px-2 py-1 text-xs"
        style={{ background: c["bg-sidebar"], color: c.fg }}
      >
        {theme.name}
      </div>
    </button>
  );
};
