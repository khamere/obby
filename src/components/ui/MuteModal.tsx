import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { useState } from "react";
import BaseModal from "../../lib/modal/BaseModal";
import { ModalBody } from "../../lib/modal/components";
import {
  type ChatKind,
  chatMute,
  muteChat,
  muteServer,
  serverMute,
  setChatMuteMentions,
  unmuteChat,
  unmuteServer,
  useMutes,
} from "../../lib/mutes";

const HOUR = 60 * 60 * 1000;

interface MuteModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: string;
  serverName: string;
  chat?: { id: string; name: string; kind: ChatKind };
  soundsOn: boolean;
  onToggleSounds: () => void;
}

function MuteSection({
  title,
  hint,
  until,
  onMute,
  onUnmute,
  extra,
}: {
  title: React.ReactNode;
  hint: React.ReactNode;
  until: number | null | undefined; // undefined = not muted
  onMute: (until: number | null) => void;
  onUnmute: () => void;
  extra?: React.ReactNode; // shown under the buttons, muted or not
}) {
  const { t } = useLingui();
  const options: { label: string; until: () => number | null }[] = [
    { label: t`1 hour`, until: () => Date.now() + HOUR },
    { label: t`8 hours`, until: () => Date.now() + 8 * HOUR },
    { label: t`24 hours`, until: () => Date.now() + 24 * HOUR },
    { label: t`Until I unmute`, until: () => null },
  ];
  const endsAt =
    typeof until === "number"
      ? new Date(until).toLocaleString(undefined, {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-discord-text-strong">
        {title}
      </h3>
      <p className="text-xs text-discord-text-muted">{hint}</p>
      {until !== undefined ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-discord-text-normal">
            {endsAt ? (
              <Trans>Muted until {endsAt}</Trans>
            ) : (
              <Trans>Muted until you unmute</Trans>
            )}
          </span>
          <button
            type="button"
            onClick={onUnmute}
            className="rounded bg-discord-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
          >
            <Trans>Unmute</Trans>
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => onMute(o.until())}
              className="rounded bg-discord-dark-400 px-3 py-1.5 text-sm text-discord-text-normal hover:bg-discord-dark-300"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {extra}
    </section>
  );
}

/** Mute the open chat and/or its whole server, for a while or until unmuted. */
export const MuteModal: React.FC<MuteModalProps> = ({
  isOpen,
  onClose,
  serverId,
  serverName,
  chat,
  soundsOn,
  onToggleSounds,
}) => {
  const { t } = useLingui();
  useMutes(); // re-render when mutes change
  const server = serverMute(serverId);
  const chatEntry = chat ? chatMute(serverId, chat.id) : undefined;
  // For a channel: whether the (next) mute also silences mentions. While a
  // mute is active the stored flag wins, so the box always shows the truth.
  const [muteMentionsDraft, setMuteMentionsDraft] = useState(false);
  const muteMentions = chatEntry ? !!chatEntry.mentions : muteMentionsDraft;
  const onMuteMentionsChange = (checked: boolean) => {
    setMuteMentionsDraft(checked);
    if (chat && chatEntry) setChatMuteMentions(serverId, chat.id, checked);
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      title={t`Mute notifications`}
      maxWidth="md"
    >
      <ModalBody>
        <div className="space-y-6">
          {chat && (
            <MuteSection
              title={chat.name}
              hint={
                chat.kind === "dm" ? (
                  <Trans>
                    No sound, notification or red dot for messages from this
                    person.
                  </Trans>
                ) : muteMentions ? (
                  <Trans>
                    No sound, notification or red dot from this channel, even
                    when someone mentions you.
                  </Trans>
                ) : (
                  <Trans>
                    No sound, notification or red dot from this channel, except
                    when someone mentions you.
                  </Trans>
                )
              }
              until={chatEntry ? chatEntry.until : undefined}
              onMute={(until) =>
                muteChat(
                  serverId,
                  chat.id,
                  chat.kind,
                  until,
                  chat.kind === "channel" && muteMentions,
                )
              }
              onUnmute={() => unmuteChat(serverId, chat.id)}
              extra={
                chat.kind === "channel" ? (
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-discord-text-normal">
                    <input
                      type="checkbox"
                      checked={muteMentions}
                      onChange={(e) => onMuteMentionsChange(e.target.checked)}
                      className="h-4 w-4 accent-discord-primary"
                    />
                    <Trans>Also mute mentions</Trans>
                  </label>
                ) : undefined
              }
            />
          )}
          <MuteSection
            title={<Trans>Whole server: {serverName}</Trans>}
            hint={
              <Trans>
                Silences everything on this server, including mentions and
                private messages, and hides its red dot.
              </Trans>
            }
            until={server ? server.until : undefined}
            onMute={(until) => muteServer(serverId, until)}
            onUnmute={() => unmuteServer(serverId)}
          />
          <section className="space-y-2 border-t border-discord-dark-400 pt-4">
            <h3 className="text-sm font-semibold text-discord-text-strong">
              <Trans>All notification sounds</Trans>
            </h3>
            <button
              type="button"
              onClick={onToggleSounds}
              className="rounded bg-discord-dark-400 px-3 py-1.5 text-sm text-discord-text-normal hover:bg-discord-dark-300"
            >
              {soundsOn ? (
                <Trans>Turn all sounds off</Trans>
              ) : (
                <Trans>Turn all sounds on</Trans>
              )}
            </button>
          </section>
        </div>
      </ModalBody>
    </BaseModal>
  );
};

export default MuteModal;
