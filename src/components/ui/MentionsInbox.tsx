import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { FaAt } from "react-icons/fa";
import { stripIrcFormatting } from "../../lib/messageFormatter";
import useStore from "../../store";
import type { MentionEntry } from "../../store/mentionLog";
import Popover from "./Popover";

function fmtAgo(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function preview(entry: MentionEntry): string {
  const isAction = entry.content.startsWith("\u0001ACTION ");
  const text = isAction
    ? `* ${entry.sender} ${entry.content.slice(8).split("\u0001")[0]}`
    : entry.content;
  return stripIrcFormatting(text).replace(/\s+/g, " ").trim();
}

// Header control listing recent mentions across every network; picking one
// opens its channel and scrolls to the message.
export const MentionsInbox: React.FC = () => {
  const { t } = useLingui();
  const mentionLog = useStore((state) => state.mentionLog);
  const servers = useStore((state) => state.servers);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const entries = useMemo(() => [...mentionLog].reverse(), [mentionLog]);
  const unseen = useMemo(
    () => mentionLog.filter((m) => !m.seen).length,
    [mentionLog],
  );

  const openMention = (entry: MentionEntry) => {
    const store = useStore.getState();
    const server = store.servers.find((s) => s.id === entry.serverId);
    if (!server?.channels.some((c) => c.id === entry.channelId)) return;
    if (store.ui.selectedServerId !== entry.serverId) {
      store.selectServer(entry.serverId);
    }
    store.selectChannel(entry.channelId, { navigate: true });
    store.jumpToMention(entry);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="relative flex items-center p-2 md:p-0 hover:text-discord-text-normal"
        onClick={() => setOpen((o) => !o)}
        title={t`Mentions`}
        aria-label={t`Mentions`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <FaAt />
        {unseen > 0 && (
          <span className="absolute -top-1.5 -right-2 md:-top-2 md:-right-2.5 bg-red-500 text-white text-[10px] font-bold leading-none rounded-full px-1 py-0.5 min-w-[16px] text-center tabular-nums">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>
      <Popover
        isOpen={open}
        onClose={() => setOpen(false)}
        anchor={triggerRef.current}
        width={360}
        title={<Trans>Mentions</Trans>}
        titleAdornment={
          unseen > 0 ? (
            <button
              type="button"
              className="text-xs text-discord-text-link hover:underline"
              onClick={() => useStore.getState().markAllMentionsSeen()}
            >
              <Trans>Mark all read</Trans>
            </button>
          ) : null
        }
        bodyClassName="max-h-[60vh]"
      >
        {entries.length === 0 ? (
          <p className="px-3 py-6 text-sm text-center text-discord-text-muted">
            <Trans>Nobody has mentioned you yet.</Trans>
          </p>
        ) : (
          <ul className="divide-y divide-discord-dark-400/60">
            {entries.map((entry) => {
              const server = servers.find((s) => s.id === entry.serverId);
              const joined = !!server?.channels.some(
                (c) => c.id === entry.channelId,
              );
              return (
                <li key={entry.messageId}>
                  <button
                    type="button"
                    disabled={!joined}
                    onClick={() => openMention(entry)}
                    className={`w-full flex gap-2.5 px-3 py-2 text-left transition-colors ${
                      joined
                        ? "hover:bg-discord-dark-400/60"
                        : "opacity-50 cursor-default"
                    }`}
                    title={joined ? t`Jump to message` : t`Not in this channel`}
                  >
                    <span
                      className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                        entry.seen ? "bg-transparent" : "bg-red-500"
                      }`}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 text-[11px] text-discord-text-muted">
                        <span className="font-semibold text-discord-text-strong truncate">
                          {entry.sender}
                        </span>
                        <span className="truncate">
                          {entry.channelName}
                          {server ? ` · ${server.name}` : ""}
                        </span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {fmtAgo(entry.timestamp)}
                        </span>
                      </div>
                      <div
                        className={`text-sm line-clamp-2 break-words ${
                          entry.seen
                            ? "text-discord-text-muted"
                            : "text-discord-text-normal"
                        }`}
                      >
                        {preview(entry)}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Popover>
    </>
  );
};
