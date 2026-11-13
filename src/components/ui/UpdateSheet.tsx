import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { useState } from "react";
import { useIsTouchInput } from "../../hooks/useIsTouchInput";
import type { UpdateError } from "../../lib/appUpdateNative";
import { APP_VERSION } from "../../lib/appVersion";
import { BaseModal } from "../../lib/modal/BaseModal";
import { Button } from "../../lib/modal/components/Button";
import { ModalBody } from "../../lib/modal/components/ModalBody";
import { ModalFooter } from "../../lib/modal/components/ModalFooter";
import { shortReleaseLabel } from "../../lib/releaseCheck";
import { selectCanInstallInApp, useAppUpdate } from "../../store/appUpdate";
import BottomSheet from "../mobile/BottomSheet";
import ExternalLinkWarningModal from "./ExternalLinkWarningModal";

const BYTES_PER_MB = 1024 * 1024;

/** Whole megabytes from ten up, one decimal below, so "79" and "4.2". */
const megabytes = (bytes: number): string => {
  const mb = bytes / BYTES_PER_MB;
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1);
};

/** The sheet opens from the version line and stays out of the way otherwise:
 *  a touch screen gets a bottom sheet, a mouse gets a dialog. */
export const UpdateSheet: React.FC = () => {
  const { t } = useLingui();
  const isTouch = useIsTouchInput();
  const isOpen = useAppUpdate((s) => s.isOpen);
  const latest = useAppUpdate((s) => s.latest);
  const phase = useAppUpdate((s) => s.phase);
  const received = useAppUpdate((s) => s.received);
  const total = useAppUpdate((s) => s.total);
  const error = useAppUpdate((s) => s.error);
  const canInstall = useAppUpdate(selectCanInstallInApp);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  if (!isOpen || !latest) return null;

  const { closeSheet, startUpdate, cancelUpdate, continueAfterPermission } =
    useAppUpdate.getState();
  const retry = () => void useAppUpdate.getState().retry();
  const label = shortReleaseLabel(latest.version);
  const version = latest.version;
  const current = APP_VERSION;
  const percent =
    total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  const errorText: Record<UpdateError, string> = {
    network: t`The download stopped. Check your connection and try again.`,
    "no-apk": t`This release has no Android app to install.`,
    checksum: t`The download did not match the release's checksum, so it was thrown away.`,
    incompatible: t`Android refused the update because it was signed by someone else. Install it from the release page.`,
    refused: t`The install was cancelled.`,
    storage: t`There is not enough free space for the update.`,
  };

  const releaseLink = (
    <button
      type="button"
      onClick={() => setPendingUrl(latest.url)}
      className="text-left text-sm text-discord-text-link hover:underline"
    >
      <Trans>Open the release page</Trans>
    </button>
  );

  let title: React.ReactNode = <Trans>Obby {version}</Trans>;
  let body: React.ReactNode;
  let actions: React.ReactNode;

  if (phase === "error") {
    title = <Trans>Update not installed</Trans>;
    body = (
      <>
        <p className="text-sm text-discord-text-normal">
          {errorText[error ?? "network"]}
        </p>
        {releaseLink}
      </>
    );
    actions = (
      <>
        <Button variant="secondary" onClick={closeSheet}>
          <Trans>Close</Trans>
        </Button>
        <Button onClick={retry}>
          <Trans>Try again</Trans>
        </Button>
      </>
    );
  } else if (phase === "downloading") {
    const done = megabytes(received);
    const all = `${megabytes(total)} MB`;
    body = (
      <>
        <p className="text-sm font-medium text-discord-text-strong">
          <Trans>Downloading {label}</Trans>
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t`Downloading ${label}`}
          className="h-2 w-full overflow-hidden rounded-full bg-discord-dark-400"
        >
          <div
            className="h-full bg-discord-green"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-sm text-discord-text-muted">
          <Trans>
            {done} of {all}
          </Trans>
        </p>
        <p className="text-sm text-discord-text-muted">
          <Trans>You can close this and keep chatting.</Trans>
        </p>
      </>
    );
    actions = (
      <Button variant="secondary" onClick={() => void cancelUpdate()}>
        <Trans>Cancel</Trans>
      </Button>
    );
  } else if (phase === "verifying") {
    body = (
      <p className="text-sm text-discord-text-normal">
        <Trans>Checking the download</Trans>
      </p>
    );
  } else if (phase === "needs-permission") {
    title = <Trans>Allow Obby to install updates</Trans>;
    body = (
      <p className="text-sm text-discord-text-normal">
        <Trans>
          Android asks once. Turn on "Allow from this source" for Obby, then
          come back; the update continues by itself.
        </Trans>
      </p>
    );
    actions = (
      <>
        <Button variant="secondary" onClick={closeSheet}>
          <Trans>Not now</Trans>
        </Button>
        <Button onClick={() => void continueAfterPermission()}>
          <Trans>Open Android settings</Trans>
        </Button>
      </>
    );
  } else if (phase === "waiting-foreground") {
    body = (
      <p className="text-sm text-discord-text-normal">
        <Trans>Ready to install. Return to Obby to continue.</Trans>
      </p>
    );
  } else if (phase === "installing") {
    body = (
      <p className="text-sm text-discord-text-normal">
        <Trans>
          Obby will close to install the update; open it again afterwards.
        </Trans>
      </p>
    );
  } else {
    const size = latest.apk ? `${megabytes(latest.apk.size)} MB` : "";
    body = (
      <>
        <p className="text-sm text-discord-text-muted">
          {latest.apk ? (
            <Trans>
              You have {current} · {size} download
            </Trans>
          ) : (
            <Trans>You have {current}</Trans>
          )}
        </p>
        {latest.notes.trim() !== "" && (
          <section
            aria-label={t`Release notes`}
            className="rounded-lg bg-discord-dark-400 p-3"
          >
            <h3 className="mb-1 text-xs font-semibold uppercase text-discord-text-muted">
              <Trans>Release notes</Trans>
            </h3>
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm text-discord-text-normal">
              {latest.notes}
            </div>
          </section>
        )}
        {canInstall && (
          <p className="text-sm text-discord-text-muted">
            <Trans>
              Obby will close to install the update; open it again afterwards.
            </Trans>
          </p>
        )}
        {releaseLink}
      </>
    );
    actions = (
      <>
        <Button variant="secondary" onClick={closeSheet}>
          <Trans>Not now</Trans>
        </Button>
        {canInstall ? (
          <Button onClick={() => void startUpdate()}>
            <Trans>Update</Trans>
          </Button>
        ) : (
          <Button onClick={() => setPendingUrl(latest.url)}>
            <Trans>Download</Trans>
          </Button>
        )}
      </>
    );
  }

  const content = (
    <>
      <div className="flex flex-col gap-3 px-5 py-3">{body}</div>
      {actions && (
        <div className="flex justify-end gap-2 px-5 pb-4">{actions}</div>
      )}
    </>
  );

  return (
    <>
      {isTouch ? (
        <BottomSheet isOpen onClose={closeSheet}>
          <div className="flex max-h-[80vh] flex-col overflow-y-auto">
            <h2 className="px-5 pb-1 text-base font-semibold text-discord-text-strong">
              {title}
            </h2>
            {content}
          </div>
        </BottomSheet>
      ) : (
        <BaseModal isOpen onClose={closeSheet} maxWidth="md" title={title}>
          <ModalBody className="gap-3">{body}</ModalBody>
          {actions && <ModalFooter>{actions}</ModalFooter>}
        </BaseModal>
      )}
      <ExternalLinkWarningModal
        isOpen={!!pendingUrl}
        url={pendingUrl ?? ""}
        onConfirm={() => setPendingUrl(null)}
        onCancel={() => setPendingUrl(null)}
      />
    </>
  );
};

export default UpdateSheet;
