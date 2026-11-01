import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { FaHdd } from "react-icons/fa";
import { getColorStyle } from "../../lib/ircUtils";
import { HoverTooltip } from "../ui/HoverTooltip";
import OperatorKey from "../ui/OperatorKey";
import { E2EEUnprotectedBadge } from "./E2EEUnprotectedBadge";

interface MessageHeaderProps {
  userId: string;
  displayName?: string;
  userColor?: string;
  timestamp: Date;
  theme: string;
  isClickable?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  isBot?: boolean;
  isVerified?: boolean;
  isIrcOp?: boolean;
  unprotected?: boolean;
  isSavedLocally?: boolean;
  // A line relayed by a shoutbox bridge: the bot nick or the rule label shown
  // after the time, the unwrapped name for web users, and the original line
  // for the hover.
  bridgedVia?: string;
  displayNick?: string;
  originalLine?: string;
}

export const MessageHeader: React.FC<MessageHeaderProps> = ({
  userId,
  displayName,
  userColor,
  timestamp,
  theme,
  isClickable = false,
  onClick,
  isBot = false,
  isVerified = false,
  isIrcOp = false,
  unprotected = false,
  isSavedLocally = false,
  bridgedVia,
  displayNick,
  originalLine,
}) => {
  const { t } = useLingui();
  const username = userId;
  const via = bridgedVia;
  const isSystem = userId === "system";

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };

  return (
    <div className="flex items-center select-none">
      <span
        className={`font-bold text-discord-text-strong ${isClickable ? "cursor-pointer" : ""}`}
        style={getColorStyle(userColor)}
        onClick={onClick}
        title={originalLine}
      >
        {isSystem ? "System" : displayName || displayNick || username}
        {isBot && <span className="ml-1 text-xs">🤖</span>}
        {isVerified && (
          <span
            className="ml-1 inline-flex items-center justify-center w-4 h-4 text-xs text-white bg-green-500 rounded-full"
            title={t`User is authenticated`}
          >
            ✓
          </span>
        )}
        {isIrcOp && <OperatorKey className="ml-0.5" />}
        {displayName && (
          <span className="ml-2 text-xs bg-discord-dark-600 px-1 py-0.5 rounded">
            {username}
          </span>
        )}
      </span>
      <span className={`ml-2 text-xs text-${theme}-text-muted`}>
        {formatTime(timestamp)}
      </span>
      {bridgedVia && (
        <span
          className={`ml-2 text-xs text-${theme}-text-muted`}
          data-bridged-via={bridgedVia}
        >
          <Trans>via {via}</Trans>
        </span>
      )}
      {isSavedLocally && (
        <HoverTooltip content={t`Saved on this device`} className="ml-1">
          <FaHdd
            role="img"
            aria-label={t`Saved on this device`}
            className={`w-3 h-3 text-${theme}-text-muted`}
          />
        </HoverTooltip>
      )}
      {unprotected && <E2EEUnprotectedBadge />}
    </div>
  );
};
