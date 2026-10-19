import type React from "react";
import { mircToHtml } from "./ircUtils";
import { stripIrcFormatting } from "./messageFormatter";

/**
 * Render a channel topic for display.
 *
 * Topics arrive raw from the server and may carry mIRC colour/formatting
 * codes. With `format` on, they are rendered the same way messages are
 * (colours, bold, …). With it off, the codes are stripped entirely so
 * only the plain text remains; the digits of a colour code never show.
 *
 * `linkify: false` emits no anchors, for places outside EnhancedLinkWrapper
 * where a clickable link would bypass the external-link warning.
 */
export function renderTopic(
  topic: string,
  keyPrefix: string,
  options: { format: boolean; linkify?: boolean },
): React.ReactNode {
  const { format, linkify = true } = options;
  if (format) {
    return mircToHtml(topic, keyPrefix, { linkify });
  }
  const plain = stripIrcFormatting(topic);
  return linkify ? mircToHtml(plain, keyPrefix) : plain;
}
