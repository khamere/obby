// A name under one of these is handed out to unrelated people, so allowing
// the whole suffix would trust strangers.
const SHARED_SUFFIXES = new Set(
  (
    "pages.dev workers.dev r2.dev netlify.app vercel.app web.app firebaseapp.com " +
    "appspot.com herokuapp.com onrender.com fly.dev glitch.me repl.co replit.app " +
    "replit.dev ngrok.io ngrok.app ngrok.dev ngrok-free.app ngrok-free.dev " +
    "trycloudflare.com duckdns.org dyndns.org amazonaws.com cloudfront.net " +
    "azurewebsites.net azureedge.net windows.net googleapis.com " +
    "googleusercontent.com github.io githubusercontent.com gitlab.io b-cdn.net " +
    "digitaloceanspaces.com backblazeb2.com blogspot.com wordpress.com uk.com " +
    "us.com eu.com de.com gb.net"
  ).split(" "),
);

// These hosts serve every customer's files from paths of one name.
const SHARED_PATH_HOSTS = new Set([
  "storage.googleapis.com",
  "firebasestorage.googleapis.com",
  "storage.cloud.google.com",
  "s3.amazonaws.com",
]);
const REGIONAL_S3_HOST = /^s3[.-][a-z0-9-]+\.amazonaws\.com$/;

const COUNTRY_SECOND_LEVELS = new Set(
  "co com org net ac gov edu or ne go mil nom sch ltd plc".split(" "),
);

const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// The URL parser turns every IPv4 spelling into a dotted quad, so a numeric
// last label is how we recognise an address.
function isHostName(host: string): boolean {
  if (host.length > 253 || !HOST_PATTERN.test(host)) return false;
  return !/^\d+$/.test(host.slice(host.lastIndexOf(".") + 1));
}

function isCountrySecondLevel(host: string): boolean {
  const labels = host.split(".");
  return (
    labels.length === 2 &&
    /^[a-z]{2}$/.test(labels[1]) &&
    COUNTRY_SECOND_LEVELS.has(labels[0])
  );
}

function isUnderSharedSuffix(host: string): boolean {
  let rest = host;
  for (;;) {
    if (SHARED_SUFFIXES.has(rest)) return true;
    const dot = rest.indexOf(".");
    if (dot === -1) return false;
    rest = rest.slice(dot + 1);
  }
}

/** True when `*.base` covers one owner's names only, as far as we can tell. */
export function isWildcardBaseAllowed(base: string): boolean {
  return (
    isHostName(base) &&
    !isCountrySecondLevel(base) &&
    !isUnderSharedSuffix(base)
  );
}

function isSharedExactHost(host: string): boolean {
  return (
    isCountrySecondLevel(host) ||
    SHARED_SUFFIXES.has(host) ||
    SHARED_PATH_HOSTS.has(host) ||
    REGIONAL_S3_HOST.test(host)
  );
}

export type MediaHostEntryResult =
  | { entry: string; error?: undefined }
  | { entry?: undefined; error: "invalid" | "shared"; host?: string };

/** Reduces what the user typed or pasted to the stored form: an exact https
 *  host on the default port, or `*.` plus one for a domain and its subdomains. */
export function parseMediaHostEntry(input: string): MediaHostEntryResult {
  let text = input.trim();
  const wildcard = text.startsWith("*.");
  if (wildcard) text = text.slice(2);
  if (!text) return { error: "invalid" };
  if (!HAS_SCHEME.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { error: "invalid" };
  if (url.username || url.password || url.port) return { error: "invalid" };

  const host = url.hostname.replace(/\.$/, "");
  if (!isHostName(host)) return { error: "invalid" };

  const shared = wildcard
    ? !isWildcardBaseAllowed(host)
    : isSharedExactHost(host);
  if (shared) return { error: "shared", host };

  return { entry: wildcard ? `*.${host}` : host };
}

/** Keeps only entries already in stored form. We drop anything else and never
 *  repair it, so a damaged list can only get shorter. */
export function sanitizeMediaAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const clean: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || clean.includes(item)) continue;
    if (parseMediaHostEntry(item).entry === item) clean.push(item);
  }
  return clean;
}

/** Returns the entry that allows `url`, or null. We compare the parsed host
 *  only, and only for https on the default port without credentials. */
export function matchAllowedMediaHost(
  url: string,
  hosts: unknown,
): string | null {
  if (!Array.isArray(hosts) || hosts.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    return null;

  const host = parsed.hostname;
  for (const entry of hosts) {
    if (typeof entry !== "string") continue;
    if (entry === host) return entry;
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      // We check the base again here, so a stored string that never passed
      // the editor cannot widen the match.
      if (
        (host === base || host.endsWith(`.${base}`)) &&
        isWildcardBaseAllowed(base)
      )
        return entry;
    }
  }
  return null;
}
