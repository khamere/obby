import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  MAX_RULES_CHARS,
  type ParsedBridgeRules,
  saveOwnBridgeRules,
  setBridgeRulesLink,
  useBridgeRulesState,
} from "../../../lib/bridgeRules";
import { isValidCssLink } from "../../../lib/customCss";
import type { SettingComponentProps } from "../../../lib/settings/types";

const inputClass =
  "w-full rounded border border-discord-button-secondary-default bg-discord-input-bg px-3 py-2 text-discord-text-normal placeholder-discord-text-muted focus:border-discord-text-link focus:outline-none disabled:opacity-50";
const buttonClass =
  "rounded px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed";

function ruleCount(rules: ParsedBridgeRules): string {
  return t`${rules.rules.length} rules loaded, ${rules.skipped} skipped`;
}

function parseErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "too-large") return t`That file is too large.`;
  if (code === "too-many-rules") return t`That file has too many rules.`;
  return t`That file is not a valid rules file.`;
}

/**
 * Bridge rules: a linked JSON file (shared by URL, kept up to date) plus the
 * user's own pasted/uploaded rules. Stored by lib/bridgeRules, not in the
 * settings object, so `value`/`onChange` are unused.
 */
export const BridgeRulesField: React.FC<SettingComponentProps> = ({
  disabled,
}) => {
  const { own, ownRules, link, linkRules, linkStatus } = useBridgeRulesState();
  const [linkDraft, setLinkDraft] = useState(link);
  const [ownDraft, setOwnDraft] = useState(own);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setLinkDraft(link), [link]);
  useEffect(() => setOwnDraft(own), [own]);

  const applyLink = async (value: string) => {
    if (value.trim() && !isValidCssLink(value.trim())) {
      setMessage(t`Enter an http(s) link to a .json file.`);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setBridgeRulesLink(value);
    } finally {
      setBusy(false);
    }
  };

  const applyOwn = (text: string) => {
    if (text.length > MAX_RULES_CHARS) {
      setMessage(t`That file is too large.`);
      return;
    }
    try {
      saveOwnBridgeRules(text);
    } catch (error) {
      setMessage(parseErrorText(error));
      return;
    }
    setMessage(
      text.trim() ? t`Your rules were saved.` : t`Your rules were removed.`,
    );
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
            ? t`Could not load this link. It must point to the raw .json file.`
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
            placeholder="https://…/bridges.json"
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
          <p className="text-xs text-discord-text-muted">
            {linkStatusText}
            {linkStatus !== "loading" && linkStatus !== "error" && (
              <> {ruleCount(linkRules)}</>
            )}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold text-discord-text-normal">
          <Trans>Your own rules</Trans>
        </p>
        <p className="text-xs text-discord-text-muted">
          <Trans>
            Kept in this browser. A rule here replaces the linked rule for the
            same network and bot.
          </Trans>
        </p>
        <textarea
          value={ownDraft}
          onChange={(e) => setOwnDraft(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          rows={6}
          placeholder={t`Paste rules JSON here or upload a .json file`}
          className={`${inputClass} font-mono text-xs`}
        />
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleFile}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className={`${buttonClass} bg-discord-button-success-default text-white hover:bg-discord-button-success-hover`}
          >
            <Trans>Upload .json file</Trans>
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
        {own && (
          <p className="text-xs text-discord-text-muted">
            {ruleCount(ownRules)}
          </p>
        )}
      </div>

      {message && <p className="text-sm text-discord-text-normal">{message}</p>}
    </div>
  );
};
