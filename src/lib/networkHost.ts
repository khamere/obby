import type { BouncerNetwork, BouncerState, Server } from "../types";

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

/**
 * The upstream IRC host of a server in the store, resolving a bouncer-bound
 * connection through its bouncer network, or "" when unknown.
 */
export function upstreamHostForServer(
  state: {
    servers: Pick<
      Server,
      "id" | "host" | "bouncerServerId" | "bouncerNetid" | "isBouncerControl"
    >[];
    bouncers: Record<string, Pick<BouncerState, "networks">>;
  },
  serverId: string,
): string {
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return "";
  const network =
    server.bouncerServerId && server.bouncerNetid
      ? state.bouncers[server.bouncerServerId]?.networks[server.bouncerNetid]
      : undefined;
  return networkHost(server as Server, network);
}
