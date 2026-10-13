import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useState } from "react";
import type { SettingComponentProps } from "../../../lib/settings/types";
import {
  isValidFilehostUrl,
  setUserFilehost,
  useUserFilehost,
} from "../../../lib/userFilehost";

const inputClass =
  "w-full rounded border border-discord-button-secondary-default bg-discord-input-bg px-3 py-2 text-discord-text-normal placeholder-discord-text-muted focus:border-discord-text-link focus:outline-none disabled:opacity-50";
const buttonClass =
  "rounded px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * The user's own upload host (Zipline). Stored by lib/userFilehost, not in
 * the settings object, so `value`/`onChange` are unused.
 */
export const UserFilehostField: React.FC<SettingComponentProps> = ({
  disabled,
}) => {
  const { url, token } = useUserFilehost();
  const [urlDraft, setUrlDraft] = useState(url);
  const [tokenDraft, setTokenDraft] = useState(token);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setUrlDraft(url), [url]);
  useEffect(() => setTokenDraft(token), [token]);

  const dirty = urlDraft.trim() !== url || tokenDraft.trim() !== token;

  const save = () => {
    const trimmed = urlDraft.trim();
    if (trimmed && !isValidFilehostUrl(trimmed)) {
      setMessage(
        t`Enter the http(s) address of your Zipline, like https://img.example.com`,
      );
      return;
    }
    setUserFilehost({ url: trimmed, token: tokenDraft });
    setMessage(trimmed ? t`File host saved.` : t`File host removed.`);
  };

  const remove = () => {
    setUrlDraft("");
    setTokenDraft("");
    setUserFilehost({ url: "", token: "" });
    setMessage(t`File host removed.`);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-discord-text-muted">
        <Trans>
          Works with Zipline v3 and v4. Copy the token from your Zipline user
          settings. The host must allow uploads from this site (CORS). Anyone
          with the token can upload as you, so only use it on your own device.
        </Trans>
      </p>
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-discord-text-normal">
          <Trans>Zipline address</Trans>
        </span>
        <input
          type="url"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          disabled={disabled}
          placeholder="https://img.example.com"
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-discord-text-normal">
          <Trans>Upload token</Trans>
        </span>
        <input
          type="password"
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder={t`Paste your Zipline token`}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          disabled={disabled || !dirty}
          className={`${buttonClass} bg-discord-primary text-white hover:opacity-90`}
        >
          <Trans>Save</Trans>
        </button>
        {url && (
          <button
            type="button"
            onClick={remove}
            disabled={disabled}
            className={`${buttonClass} bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-300`}
          >
            <Trans>Remove</Trans>
          </button>
        )}
      </div>
      {message && <p className="text-sm text-discord-text-normal">{message}</p>}
    </div>
  );
};
