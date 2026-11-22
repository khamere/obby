import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useState } from "react";
import { isJoinableChannelKey } from "../../lib/ircUtils";
import BaseModal from "../../lib/modal/BaseModal";
import {
  Button,
  Input,
  ModalBody,
  ModalFooter,
} from "../../lib/modal/components";
import useStore from "../../store";

export const ChannelKeyModal: React.FC = () => {
  const { t } = useLingui();
  const prompt = useStore((s) => s.channelKeyPrompt);
  const joinChannel = useStore((s) => s.joinChannel);
  const closeChannelKeyPrompt = useStore((s) => s.closeChannelKeyPrompt);
  const [key, setKey] = useState("");
  const [isUnusableKey, setIsUnusableKey] = useState(false);

  useEffect(() => {
    if (prompt) {
      setKey("");
      setIsUnusableKey(false);
    }
  }, [prompt]);

  if (!prompt) return null;
  const { serverId, channelName, isWrongKey } = prompt;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key) return;
    // Servers compare a key character by character, so we send it as typed.
    if (!isJoinableChannelKey(key)) {
      setIsUnusableKey(true);
      return;
    }
    joinChannel(serverId, channelName, key);
    closeChannelKeyPrompt();
  };

  return (
    <BaseModal
      isOpen
      onClose={closeChannelKeyPrompt}
      maxWidth="sm"
      title={t`Join ${channelName}`}
    >
      <form onSubmit={onSubmit} className="flex flex-col min-h-0 flex-1">
        <ModalBody>
          <Input
            type="password"
            autoComplete="off"
            aria-label={t`Channel key`}
            placeholder={t`Channel key`}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setIsUnusableKey(false);
            }}
            error={
              isWrongKey || isUnusableKey ? t`Wrong key, try again` : undefined
            }
          />
        </ModalBody>
        <ModalFooter>
          <Button type="submit" variant="primary" disabled={!key}>
            <Trans>Join</Trans>
          </Button>
        </ModalFooter>
      </form>
    </BaseModal>
  );
};

export default ChannelKeyModal;
