import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  MAX_CSS_CHARS,
  saveCustomCss,
  useCustomCssState,
} from "../../../lib/customCss";
import type { SettingComponentProps } from "../../../lib/settings/types";

/**
 * Upload, edit or remove the custom stylesheet. It is stored by
 * lib/customCss (this browser + the server when it accepts uploads), not in
 * the settings object, so `value`/`onChange` are unused.
 */
export const CustomCssField: React.FC<SettingComponentProps> = ({
  disabled,
}) => {
  const { css, source } = useCustomCssState();
  const [draft, setDraft] = useState(css);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Follow the active stylesheet (e.g. once the server copy loads) unless the
  // user has unsaved edits.
  const lastLoaded = useRef(css);
  useEffect(() => {
    setDraft((current) => (current === lastLoaded.current ? css : current));
    lastLoaded.current = css;
  }, [css]);

  const save = async (text: string) => {
    if (text.length > MAX_CSS_CHARS) {
      setStatus(t`That stylesheet is too large.`);
      return;
    }
    setBusy(true);
    try {
      const { savedOnServer } = await saveCustomCss(text);
      const removed = !text.trim();
      setStatus(
        removed
          ? savedOnServer
            ? t`Custom CSS removed for every browser.`
            : t`Custom CSS removed from this browser; the server copy could not be changed.`
          : savedOnServer
            ? t`Custom CSS saved on the server for every browser.`
            : t`Custom CSS saved in this browser only; the server did not accept the upload.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    setDraft(text);
    await save(text);
  };

  const buttonClass =
    "rounded px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="space-y-3">
      <p className="text-sm text-discord-text-muted">
        {source === "server" ? (
          <Trans>Active, stored on the server</Trans>
        ) : source === "local" ? (
          <Trans>Active, stored in this browser only</Trans>
        ) : (
          <Trans>No custom CSS</Trans>
        )}
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled || busy}
        spellCheck={false}
        rows={8}
        placeholder={t`Paste CSS here or upload a .css file`}
        className="w-full rounded border border-discord-button-secondary-default bg-discord-input-bg px-3 py-2 font-mono text-xs text-discord-text-normal placeholder-discord-text-muted focus:border-discord-text-link focus:outline-none disabled:opacity-50"
      />
      <div className="flex flex-wrap gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="text/css,.css"
          className="hidden"
          onChange={handleFile}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busy}
          className={`${buttonClass} bg-discord-button-success-default text-white hover:bg-discord-button-success-hover`}
        >
          <Trans>Upload .css file</Trans>
        </button>
        <button
          type="button"
          onClick={() => save(draft)}
          disabled={disabled || busy || draft === css}
          className={`${buttonClass} bg-discord-primary text-white hover:opacity-90`}
        >
          <Trans>Save</Trans>
        </button>
        {source !== "none" && (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              void save("");
            }}
            disabled={disabled || busy}
            className={`${buttonClass} bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-300`}
          >
            <Trans>Remove</Trans>
          </button>
        )}
      </div>
      {status && <p className="text-sm text-discord-text-normal">{status}</p>}
    </div>
  );
};
