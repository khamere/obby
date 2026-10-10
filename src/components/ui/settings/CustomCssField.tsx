import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  isValidCssLink,
  MAX_CSS_CHARS,
  saveOwnCss,
  setCssLink,
  useCustomCssState,
} from "../../../lib/customCss";
import type { SettingComponentProps } from "../../../lib/settings/types";

const inputClass =
  "w-full rounded border border-discord-button-secondary-default bg-discord-input-bg px-3 py-2 text-discord-text-normal placeholder-discord-text-muted focus:border-discord-text-link focus:outline-none disabled:opacity-50";
const buttonClass =
  "rounded px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Custom CSS: a linked stylesheet (shared by URL, kept up to date) plus the
 * user's own pasted/uploaded CSS. Stored by lib/customCss, not in the
 * settings object, so `value`/`onChange` are unused.
 */
export const CustomCssField: React.FC<SettingComponentProps> = ({
  disabled,
}) => {
  const { own, link, linkStatus } = useCustomCssState();
  const [linkDraft, setLinkDraft] = useState(link);
  const [ownDraft, setOwnDraft] = useState(own);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setLinkDraft(link), [link]);
  useEffect(() => setOwnDraft(own), [own]);

  const applyLink = async (value: string) => {
    if (value.trim() && !isValidCssLink(value.trim())) {
      setMessage(t`Enter an http(s) link to a .css file.`);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setCssLink(value);
    } finally {
      setBusy(false);
    }
  };

  const applyOwn = (text: string) => {
    if (text.length > MAX_CSS_CHARS) {
      setMessage(t`That stylesheet is too large.`);
      return;
    }
    saveOwnCss(text);
    setMessage(text.trim() ? t`Your CSS was saved.` : t`Your CSS was removed.`);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    setOwnDraft(text);
    applyOwn(text);
  };

  const linkStatusText =
    linkStatus === "loading"
      ? t`Loading…`
      : linkStatus === "ok"
        ? t`Loaded and up to date.`
        : linkStatus === "cached"
          ? t`Using the last saved copy; the link could not be reached.`
          : linkStatus === "error"
            ? t`Could not load this link. It must point to the raw .css file.`
            : null;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-discord-text-normal">
          <Trans>Load from a link</Trans>
        </p>
        <p className="text-xs text-discord-text-muted">
          <Trans>
            Obby downloads this file every time it starts, so everyone using the
            same link gets updates. This contacts the site the link points to.
          </Trans>
        </p>
        <div className="flex gap-2">
          <input
            type="url"
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            disabled={disabled || busy}
            placeholder="https://…/style.css"
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => applyLink(linkDraft)}
            disabled={disabled || busy || linkDraft.trim() === link}
            className={`${buttonClass} bg-discord-primary text-white hover:opacity-90`}
          >
            <Trans>Save</Trans>
          </button>
          {link && (
            <button
              type="button"
              onClick={() => applyLink("")}
              disabled={disabled || busy}
              className={`${buttonClass} bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-300`}
            >
              <Trans>Remove</Trans>
            </button>
          )}
        </div>
        {link && linkStatusText && (
          <p className="text-xs text-discord-text-muted">{linkStatusText}</p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold text-discord-text-normal">
          <Trans>Your own CSS</Trans>
        </p>
        <p className="text-xs text-discord-text-muted">
          <Trans>
            Kept in this browser and applied after the linked file, so it can
            override it.
          </Trans>
        </p>
        <textarea
          value={ownDraft}
          onChange={(e) => setOwnDraft(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          rows={6}
          placeholder={t`Paste CSS here or upload a .css file`}
          className={`${inputClass} font-mono text-xs`}
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
            disabled={disabled}
            className={`${buttonClass} bg-discord-button-success-default text-white hover:bg-discord-button-success-hover`}
          >
            <Trans>Upload .css file</Trans>
          </button>
          <button
            type="button"
            onClick={() => applyOwn(ownDraft)}
            disabled={disabled || ownDraft === own}
            className={`${buttonClass} bg-discord-primary text-white hover:opacity-90`}
          >
            <Trans>Save</Trans>
          </button>
          {own && (
            <button
              type="button"
              onClick={() => {
                setOwnDraft("");
                applyOwn("");
              }}
              disabled={disabled}
              className={`${buttonClass} bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-300`}
            >
              <Trans>Remove</Trans>
            </button>
          )}
        </div>
      </div>

      {message && <p className="text-sm text-discord-text-normal">{message}</p>}
    </div>
  );
};
