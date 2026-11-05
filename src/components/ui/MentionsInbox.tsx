import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaAt, FaChevronDown, FaChevronRight } from "react-icons/fa";
import { stripIrcFormatting } from "../../lib/messageFormatter";
import { isSilenced, nextMuteExpiry, useMutes } from "../../lib/mutes";
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
  const [showMuted, setShowMuted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mutes = useMutes();
  // A timed mute ends without a mute change, so the groups are rebuilt
  // when the earliest one runs out.
  const [expired, setExpired] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextMuteExpiry reads the mute state that `mutes` tracks, and `expired` re-arms the timer
  useEffect(() => {
    const next = nextMuteExpiry();
    if (next === undefined) return;
    const timer = setTimeout(
      () => setExpired((n) => n + 1),
      Math.min(next - Date.now() + 1, 0x7fffffff),
    );
    return () => clearTimeout(timer);
  }, [mutes, expired]);

  // Mentions from muted channels stay out of the way: their own list,
  // folded, and never in the badge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isSilenced reads the mute state that `mutes` and `expired` track
  const { entries, muted } = useMemo(() => {
    const entries: MentionEntry[] = [];
    const muted: MentionEntry[] = [];
    for (const entry of [...mentionLog].reverse()) {
      (isSilenced(entry.serverId, entry.channelId, true)
        ? muted
        : entries
      ).push(entry);
    }
    return { entries, muted };
  }, [mentionLog, mutes, expired]);
  const hasUnread = useMemo(
    () =>
      servers.some((s) =>
        [...s.channels, ...(s.privateChats ?? [])].some(
          (c) => c.unreadCount > 0 || c.isMentioned,
        ),
      ),
    [servers],
  );
  const unseen = useMemo(
    () => entries.filter((m) => !m.seen).length,
    [entries],
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

  const renderList = (list: MentionEntry[]) => (
    <ul className="divide-y divide-discord-dark-400/60">
      {list.map((entry) => {
        const server = servers.find((s) => s.id === entry.serverId);
        const joined = !!server?.channels.some((c) => c.id === entry.channelId);
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
  );

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
          unseen > 0 || hasUnread ? (
            <span className="flex items-center gap-2 text-xs">
              {unseen > 0 && (
                <button
                  type="button"
                  className="text-discord-text-link hover:underline"
                  onClick={() => useStore.getState().markAllMentionsSeen()}
                >
                  <Trans>Read all mentions</Trans>
                </button>
              )}
              {unseen > 0 && hasUnread && (
                <span className="text-discord-text-muted" aria-hidden="true">
                  ·
                </span>
              )}
              {hasUnread && (
                <button
                  type="button"
                  className="text-discord-text-link hover:underline"
                  onClick={() => useStore.getState().markAllRead()}
                  title={t`Mark every chat on every network read`}
                >
                  <Trans>Read all</Trans>
                </button>
              )}
            </span>
          ) : null
        }
        bodyClassName="max-h-[60vh]"
      >
        {entries.length === 0 && muted.length === 0 ? (
          <p className="px-3 py-6 text-sm text-center text-discord-text-muted">
            <Trans>Nobody has mentioned you yet.</Trans>
          </p>
        ) : (
          <>
            {renderList(entries)}
            {muted.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowMuted((v) => !v)}
                  aria-expanded={showMuted}
                  className="section-label flex w-full items-center gap-1.5 px-3 pt-3 pb-1 text-left hover:text-discord-text-normal"
                >
                  {showMuted ? (
                    <FaChevronDown className="text-[10px]" />
                  ) : (
                    <FaChevronRight className="text-[10px]" />
                  )}
                  <Trans>Muted channels ({muted.length})</Trans>
                </button>
                {showMuted && renderList(muted)}
              </>
            )}
          </>
        )}
      </Popover>
    </>
  );
};
