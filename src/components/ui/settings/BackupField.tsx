import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { useRef, useState } from "react";
import {
  BackupFailure,
  backupFileName,
  decryptBackup,
  encryptBackup,
  PASSWORD_MIN_LENGTH,
  restoreStorage,
  snapshotStorage,
} from "../../../lib/backup";
import BaseModal from "../../../lib/modal/BaseModal";
import { Button, ModalBody, ModalFooter } from "../../../lib/modal/components";
import { saveFileToDevice } from "../../../lib/saveFile";
import type { SettingComponentProps } from "../../../lib/settings/types";

const inputClass =
  "w-full rounded border border-discord-button-secondary-default bg-discord-dark-100 px-3 py-2 text-discord-text-normal placeholder-discord-text-muted focus:border-discord-text-link focus:outline-none disabled:opacity-50";
const buttonClass =
  "rounded px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Saves everything this browser knows (servers, passwords, tokens, keys,
 * settings) to one password-protected file, and puts such a file back.
 * Nothing here touches the settings object, so `value`/`onChange` are unused.
 */
export const BackupField: React.FC<SettingComponentProps> = ({ disabled }) => {
  const { t } = useLingui();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const canSave =
    !disabled &&
    !busy &&
    password.length >= PASSWORD_MIN_LENGTH &&
    confirm === password;
  const canRestore =
    !disabled && !busy && !!restoreFile && restorePassword.length > 0;

  const failureText = (error: unknown): string => {
    const code = error instanceof BackupFailure ? error.code : "";
    if (code === "wrong-password")
      return t`Wrong password, or the file was changed since it was saved.`;
    if (code === "unsupported")
      return t`This backup was made by a newer Obby. Update first.`;
    return t`That file is not an Obby backup.`;
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await encryptBackup(snapshotStorage(), password);
      await saveFileToDevice(
        new File([text], backupFileName(), { type: "application/json" }),
      );
      setPassword("");
      setConfirm("");
      setMessage(t`Backup saved. Keep the password: it cannot be recovered.`);
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    if (!restoreFile) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = await decryptBackup(
        await restoreFile.text(),
        restorePassword,
      );
      setPending(payload.entries);
    } catch (error) {
      setMessage(failureText(error));
    } finally {
      setBusy(false);
    }
  };

  const replace = () => {
    if (!pending) return;
    restoreStorage(pending);
    window.location.reload();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-xs text-discord-text-muted">
          <Trans>
            The file holds your servers with their passwords, upload tokens,
            encryption keys, settings and layout, locked with the password you
            choose here. Chat history is not included.
          </Trans>
        </p>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-discord-text-normal">
            <Trans>Backup password</Trans>
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled || busy}
            autoComplete="new-password"
            placeholder={t`At least ${PASSWORD_MIN_LENGTH} characters`}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-discord-text-normal">
            <Trans>Repeat password</Trans>
          </span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={disabled || busy}
            autoComplete="new-password"
            className={inputClass}
          />
        </label>
        {tooShort && (
          <p className="text-xs text-discord-red">
            <Trans>Use at least {PASSWORD_MIN_LENGTH} characters.</Trans>
          </p>
        )}
        {confirm.length > 0 && confirm !== password && (
          <p className="text-xs text-discord-red">
            <Trans>The passwords do not match.</Trans>
          </p>
        )}
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className={`${buttonClass} bg-discord-primary text-white hover:opacity-90`}
        >
          <Trans>Download backup</Trans>
        </button>
      </div>

      <div className="space-y-2 border-t border-discord-dark-400 pt-4">
        <span className="text-sm font-semibold text-discord-text-normal">
          <Trans>Restore a backup</Trans>
        </span>
        <p className="text-xs text-discord-text-muted">
          <Trans>
            Restoring replaces everything Obby keeps in this browser with the
            backup, then reloads.
          </Trans>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              setRestoreFile(e.target.files?.[0] ?? null);
              setMessage(null);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || busy}
            className={`${buttonClass} bg-discord-dark-400 text-discord-text-normal hover:bg-discord-dark-500/40`}
          >
            <Trans>Choose backup file</Trans>
          </button>
          <span className="text-xs text-discord-text-muted">
            {restoreFile?.name}
          </span>
        </div>
        <input
          type="password"
          value={restorePassword}
          onChange={(e) => setRestorePassword(e.target.value)}
          disabled={disabled || busy}
          autoComplete="off"
          placeholder={t`Password of that backup`}
          className={inputClass}
        />
        <button
          type="button"
          onClick={unlock}
          disabled={!canRestore}
          className={`${buttonClass} bg-discord-primary text-white hover:opacity-90`}
        >
          <Trans>Restore</Trans>
        </button>
      </div>

      {message && <p className="text-xs text-discord-text-muted">{message}</p>}

      <BaseModal
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        maxWidth="md"
        title={<Trans>Replace everything on this device?</Trans>}
      >
        <ModalBody>
          <p className="text-sm text-discord-text-muted">
            <Trans>
              Your current servers, settings and keys in this browser are
              replaced by the backup. Obby reloads afterwards.
            </Trans>
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setPending(null)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="danger" onClick={replace}>
            <Trans>Replace and reload</Trans>
          </Button>
        </ModalFooter>
      </BaseModal>
    </div>
  );
};
