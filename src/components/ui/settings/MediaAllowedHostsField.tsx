import { XMarkIcon } from "@heroicons/react/24/solid";
import { useLingui } from "@lingui/react/macro";
import type React from "react";
import { useRef, useState } from "react";
import { useIsTouchInput } from "../../../hooks/useIsTouchInput";
import { parseMediaHostEntry } from "../../../lib/mediaAllowedHosts";
import { needsTrustedSources } from "../../../lib/mediaUtils";
import type { SettingComponentProps } from "../../../lib/settings/types";
import { TextInput } from "../TextInput";

type EntryError = {
  code: "invalid" | "shared" | "builtin" | "duplicate";
  host: string;
};

/** Editor for the sites the user allows for media previews. */
export const MediaAllowedHostsField: React.FC<SettingComponentProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const { t } = useLingui();
  const isTouch = useIsTouchInput();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<EntryError | null>(null);
  const list = Array.isArray(value) ? value : [];

  const add = () => {
    inputRef.current?.focus();
    const parsed = parseMediaHostEntry(draft);
    if (parsed.error) {
      setError({ code: parsed.error, host: parsed.host ?? "" });
      return;
    }
    const bare = parsed.entry.replace(/^\*\./, "");
    if (needsTrustedSources(bare)) {
      setError({ code: "builtin", host: bare });
      return;
    }
    if (list.includes(parsed.entry)) {
      setError({ code: "duplicate", host: parsed.entry });
      return;
    }
    onChange([...list, parsed.entry]);
    setDraft("");
    setError(null);
  };

  const errorText = (() => {
    if (!error) return null;
    const host = error.host;
    switch (error.code) {
      case "invalid":
        return t`Enter a site name such as files.example.com, or paste a link to it. Ports and IP addresses cannot be added.`;
      case "shared":
        return t`Add the exact site instead. ${host} is shared by many unrelated people.`;
      case "builtin":
        return t`Set Media Previews to Trusted Sources to preview ${host}. It also loads from other sites, so it cannot be added here.`;
      case "duplicate":
        return t`${host} is already on the list.`;
    }
  })();

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex space-x-2">
          <TextInput
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // We handle Enter here so the input keeps focus for the next site.
              e.preventDefault();
              if (draft.trim()) add();
            }}
            disabled={disabled}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t`files.example.com or a pasted link`}
            className={`min-w-0 flex-1 rounded border px-3 py-2 text-discord-text-normal placeholder-discord-text-muted focus:outline-none disabled:opacity-50 ${
              error
                ? "border-red-500 bg-red-900/20 focus:border-red-400"
                : "border-discord-button-secondary-default bg-discord-dark-400 focus:border-discord-text-link"
            }`}
          />
          <button
            type="button"
            onClick={add}
            disabled={disabled || !draft.trim()}
            className={`rounded bg-discord-button-success-default px-4 py-2 text-white hover:bg-discord-button-success-hover disabled:opacity-50 disabled:cursor-not-allowed ${
              isTouch ? "min-h-11" : ""
            }`}
          >
            {t`Add`}
          </button>
        </div>
        {errorText && (
          <p className="text-red-400 text-xs break-words">{errorText}</p>
        )}
        <p className="text-discord-text-muted text-xs">
          {t`Paste a link to add the site that serves the file; it often differs from the page you opened. A name matches that exact site over https. Add *.example.com to cover example.com and all its subdomains.`}
        </p>
        <p className="text-discord-text-muted text-xs">
          {t`Add only sites you trust. On every server, a link to an allowed site makes Obby contact that site, which shows it your IP address. Anyone who can put files on the site can post such a link, and the site can pass your request on to another site.`}
        </p>
      </div>
      {list.length > 0 && (
        <div className="space-y-1 bg-discord-dark-400 rounded p-3">
          {list.map((host) => (
            <div
              key={host}
              className="flex items-center justify-between gap-2 bg-discord-dark-500 rounded px-3 py-2"
            >
              <code className="min-w-0 break-all text-discord-text-normal text-sm font-mono">
                {host}
              </code>
              <button
                type="button"
                onClick={() => onChange(list.filter((h) => h !== host))}
                disabled={disabled}
                className={`flex shrink-0 items-center justify-center text-red-400 hover:text-red-300 disabled:opacity-50 ${
                  isTouch ? "w-11 h-11" : ""
                }`}
                title={t`Remove ${host}`}
                aria-label={t`Remove ${host}`}
              >
                <XMarkIcon className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MediaAllowedHostsField;
