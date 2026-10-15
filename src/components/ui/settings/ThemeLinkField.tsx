import { useLingui } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useState } from "react";
import type { SettingComponentProps } from "../../../lib/settings/types";
import {
  isValidThemeLink,
  setThemeLink,
  useThemeLinkState,
} from "../../../lib/themeLink";

/**
 * Theme by link: the URL of a theme JSON file, fetched at startup like the
 * custom CSS link. Stored by lib/themeLink, not in settings; pick "From
 * link" in the theme list to use it.
 */
export const ThemeLinkField: React.FC<SettingComponentProps> = ({
  disabled,
}) => {
  const { t } = useLingui();
  const { link, status, theme } = useThemeLinkState();
  const [draft, setDraft] = useState(link);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(link), [link]);

  const apply = async () => {
    const value = draft.trim();
    if (value && !isValidThemeLink(value)) {
      setError(t`Enter an http(s) link to a theme .json file.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await setThemeLink(value);
    } finally {
      setBusy(false);
    }
  };

  const statusText =
    status === "ok" && theme
      ? t`Loaded: ${theme.name}`
      : status === "cached" && theme
        ? t`Using the last copy of ${theme.name}; the link could not be reached.`
        : status === "loading"
          ? t`Loading…`
          : status === "error"
            ? t`Could not load this link.`
            : null;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={draft}
          disabled={disabled || busy}
          placeholder="https://example.org/theme.json"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void apply();
          }}
          className="flex-1 bg-discord-dark-400 text-discord-text-normal rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-discord-primary disabled:opacity-50"
        />
        <button
          type="button"
          disabled={disabled || busy || draft.trim() === link}
          onClick={() => void apply()}
          className="rounded px-4 py-2 bg-discord-primary text-white disabled:opacity-50"
        >
          {t`Load`}
        </button>
      </div>
      {error && <div className="text-sm text-discord-red">{error}</div>}
      {statusText && (
        <div className="text-sm text-discord-text-muted">{statusText}</div>
      )}
    </div>
  );
};
