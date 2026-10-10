import type { BouncerNetwork, Server } from "../types";

function hostname(address: string): string {
  try {
    const url = new URL(
      address.includes("://") ? address : `ircs://${address}`,
    );
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * The upstream IRC host a sidebar row stands for, lowercased, or "" when
 * unknown (and for the bouncer control row). Exposed on rows as
 * data-network-host so custom CSS can target a network.
 */
export function networkHost(server: Server, network?: BouncerNetwork): string {
  if (server.isBouncerControl) return "";
  // A bound connection's server.host is the bouncer, not the upstream IRC host.
  return hostname(
    server.bouncerNetid ? network?.attributes.host || "" : server.host,
  );
}
