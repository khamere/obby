import { useLingui } from "@lingui/react/macro";
import type React from "react";
import { useRef, useState } from "react";
import {
  isValidBackgroundImage,
  MAX_BACKGROUND_CHARS,
} from "../../../lib/chatLook";
import type { SettingComponentProps } from "../../../lib/settings/types";

/**
 * Background image behind the messages, kept in this browser as a data URI
 * so nothing is ever fetched for it.
 */
export const ChatBackgroundField: React.FC<SettingComponentProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const { t } = useLingui();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const current =
    typeof value === "string" && isValidBackgroundImage(value) ? value : "";

  const load = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const uri = String(reader.result ?? "");
      if (!isValidBackgroundImage(uri)) {
        setError(
          uri.length >= MAX_BACKGROUND_CHARS
            ? t`That image is too large (2 MB at most).`
            : t`Use a PNG, JPEG, WebP or GIF image.`,
        );
        return;
      }
      setError(null);
      onChange(uri);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {current ? (
          <img
            src={current}
            alt=""
            className="w-24 h-14 object-cover rounded border border-discord-dark-500"
          />
        ) : (
          <div className="w-24 h-14 rounded border border-dashed border-discord-dark-500" />
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className="rounded px-3 py-1.5 text-sm bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-500 disabled:opacity-50"
        >
          {t`Choose image…`}
        </button>
        {current && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange("")}
            className="rounded px-3 py-1.5 text-sm bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-500 disabled:opacity-50"
          >
            {t`Remove`}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) load(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="text-sm text-discord-red">{error}</div>}
    </div>
  );
};
