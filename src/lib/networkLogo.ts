import type { BouncerNetwork, Server } from "../types";
import logos from "./networkLogos.json";
import { serverDisplayName } from "./serverDisplayName";

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

/** Bundled branding only; never derive asset URLs from network-supplied text. */
export function networkLogo(
  server: Server,
  network?: BouncerNetwork,
): string | undefined {
  if (server.isBouncerControl) return undefined;
  // A bound connection's server.host is the bouncer, not the upstream IRC host.
  const host = hostname(
    server.bouncerNetid ? network?.attributes.host || "" : server.host,
  );
  const name = serverDisplayName(server, network).trim().toLowerCase();
  const brand =
    logos.find((logo) => logo.hosts.includes(host)) ||
    logos.find((logo) =>
      logo.names.some((alias) => alias.toLowerCase() === name),
    );
  return brand
    ? `${import.meta.env.BASE_URL}network-logos/${brand.file}`
    : undefined;
}
