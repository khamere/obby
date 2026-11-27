import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useReducer } from "react";
import { FaPaperPlane, FaTimes } from "react-icons/fa";
import { useIsTouchInput } from "../../hooks/useIsTouchInput";
import ircClient from "../../lib/ircClient";
import { BarButton, ProgressTrack } from "./UploadProgressBar";

// Messages that wait for their turn leave over minutes, so we show how many are left and let the user drop them.
export const SendQueueBar: React.FC<{ serverId: string | null }> = ({
  serverId,
}) => {
  const { t } = useLingui();
  const isTouch = useIsTouchInput();
  const [, readAgain] = useReducer((reads: number) => reads + 1, 0);

  useEffect(() => {
    let frame = 0;
    // A send also resizes the composer, and the chat stays on its newest line
    // only when our row changes the height on a frame of its own.
    const onChange = (event: { serverId: string }) => {
      if (event.serverId !== serverId) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readAgain);
    };
    ircClient.on("sendQueue", onChange);
    return () => {
      ircClient.deleteHook("sendQueue", onChange);
      cancelAnimationFrame(frame);
    };
  }, [serverId]);

  if (!serverId) return null;
  const { waiting, total } = ircClient.waitingLines(serverId);
  if (waiting === 0) return null;
  const totalLines = waiting;

  return (
    <div className="shrink-0 border-b border-discord-dark-400 bg-discord-dark-300 animate-in slide-in-from-top-2 duration-200">
      <div
        className={`relative flex items-center gap-2 px-3 min-w-0 ${isTouch ? "h-11" : "h-9"}`}
      >
        <FaPaperPlane className="w-3 h-3 text-discord-text-muted shrink-0" />
        <span className="flex-1 min-w-0 truncate text-xs text-discord-text-normal">
          {t`Sending`}
        </span>
        <span className="row-meta whitespace-nowrap">
          {plural(totalLines, { one: "# line", other: "# lines" })}
        </span>
        <BarButton
          label={t`Cancel`}
          onClick={() => ircClient.cancelWaitingLines(serverId)}
        >
          <FaTimes className="w-3 h-3" />
        </BarButton>
      </div>
      <div className="px-3 pb-2">
        <ProgressTrack
          percent={total > 0 ? ((total - waiting) / total) * 100 : 0}
          isFailed={false}
        />
      </div>
    </div>
  );
};

export default SendQueueBar;
