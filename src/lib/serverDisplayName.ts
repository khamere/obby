import type { BouncerNetwork, Server } from "../types";

export function serverDisplayName(
  server: Server,
  network?: BouncerNetwork,
): string {
  if (server.bouncerNetid) {
    // A known nameless network must not prefer a stale or generated saved name.
    const name = network ? network.attributes.name : server.name;
    return name || server.networkName || server.name || "";
  }
  return server.networkName || server.name || "";
}
