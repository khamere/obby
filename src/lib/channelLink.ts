import ircClient from "./ircClient";
import { channelFromLink } from "./ircUtils";

/** The channel an invite link asks us to join, read from the `channel`
 * parameter of the address. A link encodes the prefix ("?channel=%23weather"),
 * because a literal `#` starts the fragment and leaves the parameter empty.
 * We take the parameter out of the address so a reload does not join again,
 * and keep every other parameter for the page that hosts us. */
export function takeChannelFromAddress(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("channel");
    if (!raw) return null;
    params.delete("channel");
    const remaining = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname +
        (remaining ? `?${remaining}` : "") +
        window.location.hash,
    );
    return channelFromLink(raw);
  } catch {
    return null;
  }
}

/** Joins `channel` once, on the first server that finishes registration, so a
 * saved server reconnecting and a newly added one are both covered. */
export function joinOnFirstReady(
  channel: string,
  join: (serverId: string, channel: string) => void,
): void {
  const onReady = ({ serverId }: { serverId: string }) => {
    ircClient.deleteHook("ready", onReady);
    join(serverId, channel);
  };
  ircClient.on("ready", onReady);
}
