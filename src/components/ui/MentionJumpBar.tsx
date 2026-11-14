import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type React from "react";
import { useMemo } from "react";
import { FaArrowUp, FaAt, FaTimes } from "react-icons/fa";
import useStore from "../../store";
import { unseenMentions } from "../../store/mentionLog";

// Floats over the top of a channel while it has mentions you haven't been
// taken to yet; each click jumps to the oldest one.
export const MentionJumpBar: React.FC<{ channelKey: string }> = ({
  channelKey,
}) => {
  const { t } = useLingui();
  const mentionLog = useStore((state) => state.mentionLog);
  const pending = useMemo(
    () => unseenMentions(mentionLog, channelKey),
    [mentionLog, channelKey],
  );
  if (pending.length === 0) return null;

  const count = pending.length;
  return (
    <div className="relative h-0 z-40">
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center rounded-full bg-red-500 text-white text-xs font-semibold shadow-lg whitespace-nowrap">
        <button
          type="button"
          className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-l-full hover:bg-red-600 transition-colors"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useStore.getState().jumpToMention(pending[0])}
          title={t`Jump to the oldest one`}
        >
          <FaAt className="w-3 h-3" />
          {plural(count, {
            one: t`1 new mention`,
            other: t`${count} new mentions`,
          })}
          <FaArrowUp className="w-3 h-3" />
        </button>
        <button
          type="button"
          className="px-2 py-1.5 rounded-r-full border-l border-white/30 hover:bg-red-600 transition-colors"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useStore.getState().dismissMentions(channelKey)}
          aria-label={t`Dismiss mentions`}
        >
          <FaTimes className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};
