import { Trans } from "@lingui/react/macro";
import type React from "react";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { FaExclamationTriangle } from "react-icons/fa";
import BaseModal from "./BaseModal";
import { Button, ModalBody, ModalFooter } from "./components";
import { buttonClassName } from "./components/Button";

type ConfirmVariant = "primary" | "danger";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant?: ConfirmVariant;
  // With a link, the confirm control is a real anchor that opens it in a
  // new tab: browsers never popup-block a click on a link, unlike
  // window.open from a handler.
  confirmHref?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Clicking outside, Escape and Cancel all decline.
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  icon = <FaExclamationTriangle className="text-yellow-500 text-xl" />,
  children,
  confirmLabel,
  confirmVariant = "primary",
  confirmHref,
  onConfirm,
  onCancel,
}) => (
  <BaseModal
    isOpen={isOpen}
    onClose={onCancel}
    maxWidth="md"
    title={
      <span className="flex items-center gap-3">
        <span className="flex-shrink-0">{icon}</span>
        <span>{title}</span>
      </span>
    }
  >
    <ModalBody>{children}</ModalBody>
    <ModalFooter>
      <Button variant="secondary" onClick={onCancel}>
        <Trans>Cancel</Trans>
      </Button>
      {confirmHref ? (
        <a
          href={confirmHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onConfirm}
          className={buttonClassName(confirmVariant)}
        >
          {confirmLabel}
        </a>
      ) : (
        <Button variant={confirmVariant} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      )}
    </ModalFooter>
  </BaseModal>
);

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  resolve: (confirmed: boolean) => void;
}

let pending: ConfirmRequest | null = null;
const listeners = new Set<() => void>();

function setPending(next: ConfirmRequest | null) {
  pending = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The Tauri webview on macOS and iOS answers window.confirm with false without
// showing anything, so we ask every destructive question through this dialog.
export function confirmDestructive(
  title: string,
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) =>
    setPending({ title, message, confirmLabel, resolve }),
  );
}

function settle(confirmed: boolean) {
  const request = pending;
  setPending(null);
  request?.resolve(confirmed);
}

export const ConfirmDialogHost: React.FC = () => {
  const request = useSyncExternalStore(subscribe, () => pending);
  return (
    <ConfirmDialog
      isOpen={request !== null}
      title={request?.title}
      confirmLabel={request?.confirmLabel}
      confirmVariant="danger"
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      <p className="text-discord-text-normal">{request?.message}</p>
    </ConfirmDialog>
  );
};
