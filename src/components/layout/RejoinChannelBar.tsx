import { Trans } from "@lingui/react/macro";
import type React from "react";
import { FaSignOutAlt } from "react-icons/fa";
import { useIsTouchInput } from "../../hooks/useIsTouchInput";
import useStore from "../../store";
import type { Channel } from "../../types";

// A channel we are out of takes no messages, so this bar stands where the message box would be.
export const RejoinChannelBar: React.FC<{
  serverId: string;
  channelName: string;
  leftReason: NonNullable<Channel["leftReason"]>;
}> = ({ serverId, channelName, leftReason }) => {
  const joinChannel = useStore((state) => state.joinChannel);
  const isTouch = useIsTouchInput();

  return (
    <div
      className="flex items-center gap-3 rounded-md border border-discord-dark-500 bg-discord-dark-300 px-3 py-2"
      data-testid="rejoin-channel-bar"
    >
      <FaSignOutAlt className="flex-shrink-0 text-discord-text-muted" />
      <div className="min-w-0 flex-1 text-sm text-discord-text-normal">
        {leftReason === "kicked" ? (
          <Trans>You were kicked from this channel.</Trans>
        ) : (
          <Trans>You left this channel.</Trans>
        )}
      </div>
      <button
        type="button"
        className={`rounded button-primary px-3 text-xs font-medium ${isTouch ? "min-h-11 min-w-11" : "py-1"}`}
        onClick={() => joinChannel(serverId, channelName)}
      >
        <Trans>Rejoin</Trans>
      </button>
    </div>
  );
};
