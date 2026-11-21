import { Trans } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { FaTrash } from "react-icons/fa";
import BaseModal from "../../lib/modal/BaseModal";
import { Button, ModalBody, ModalFooter } from "../../lib/modal/components";
import useStore from "../../store";
import { SavedHistoryChoice } from "./SavedHistoryChoice";

export const BouncerNetworkDisconnectConfirmModal: React.FC = () => {
  const target = useStore((s) => s.ui.disconnectNetworkConfirmTarget);
  const servers = useStore((s) => s.servers);
  const bouncers = useStore((s) => s.bouncers);
  const cancel = useStore((s) => s.cancelDisconnectNetwork);
  const confirm = useStore((s) => s.confirmDisconnectNetwork);
  const [shouldDeleteHistory, setShouldDeleteHistory] = useState(false);
  const childServerId = target?.childServerId;
  const isControlUp = useStore(
    (s) =>
      s.servers.find((srv) => srv.id === target?.bouncerServerId)
        ?.isConnected === true,
  );

  useEffect(() => {
    if (childServerId) setShouldDeleteHistory(false);
  }, [childServerId]);

  const network = useMemo(() => {
    if (!target) return null;
    const child = servers.find((s) => s.id === target.childServerId);
    const attrs =
      bouncers[target.bouncerServerId]?.networks[target.netid]?.attributes;
    const name =
      attrs?.name || child?.networkName || child?.name || `#${target.netid}`;
    const host = attrs?.host || child?.host || "";
    return { name, host };
  }, [target, servers, bouncers]);

  if (!target || !network) return null;

  const isDeleting = target.status === "deleting";
  const refusal =
    target.status === "refused"
      ? bouncers[target.bouncerServerId]?.lastError?.description
      : undefined;

  return (
    <BaseModal
      isOpen
      onClose={cancel}
      maxWidth="md"
      title={
        <span className="flex items-center gap-2">
          <FaTrash className="text-discord-red text-sm" />
          <Trans>Delete network?</Trans>
        </span>
      }
    >
      <ModalBody className="gap-3">
        <p className="text-sm text-discord-text-normal">
          <Trans>
            Delete <span className="font-semibold">{network.name}</span> from
            your bouncer?
          </Trans>
        </p>
        {network.host && (
          <p className="text-xs text-discord-text-muted">{network.host}</p>
        )}
        <p className="text-sm text-discord-text-normal">
          <Trans>
            The bouncer drops this network for all your devices, together with
            its channel list and the chat history the bouncer keeps for it.
          </Trans>
        </p>
        <SavedHistoryChoice
          serverIds={[target.childServerId]}
          shouldDelete={shouldDeleteHistory}
          onChange={setShouldDeleteHistory}
        />
        {!isControlUp && (
          <p
            role="alert"
            className="rounded bg-red-600/10 border border-red-600/40 text-red-300 px-3 py-2 text-sm"
            data-testid="bouncer-delete-offline"
          >
            <Trans>
              The bouncer is not connected. Delete the network once it is back.
            </Trans>
          </p>
        )}
        {isControlUp && target.status === "refused" && (
          <p
            role="alert"
            className="rounded bg-red-600/10 border border-red-600/40 text-red-300 px-3 py-2 text-sm"
            data-testid="bouncer-delete-refused"
          >
            {refusal ? (
              <Trans>
                The bouncer kept the network and answered: {refusal}
              </Trans>
            ) : (
              <Trans>The bouncer kept the network.</Trans>
            )}
          </p>
        )}
      </ModalBody>

      <ModalFooter>
        <Button variant="secondary" onClick={cancel} disabled={isDeleting}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="danger"
          onClick={() => confirm(shouldDeleteHistory)}
          disabled={isDeleting || !isControlUp}
        >
          {isDeleting ? (
            <Trans>Deleting…</Trans>
          ) : (
            <Trans>Delete network</Trans>
          )}
        </Button>
      </ModalFooter>
    </BaseModal>
  );
};

export default BouncerNetworkDisconnectConfirmModal;
