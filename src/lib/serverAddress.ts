// The native apps connect either over a WebSocket or over a raw TCP socket,
// and the add-server form keeps the host and the port in separate fields.
// This turns what the user typed into the address the connection needs:
// a scheme in the host field decides the kind of connection, a port in it
// wins over the port field, and a WebSocket keeps its path and query, since
// a bouncer behind a web server usually listens on a path of its own.
export function buildNativeAddress(
  typedHost: string,
  portField: number,
  useWebSocket: boolean,
): string {
  const typed = typedHost.trim();
  const scheme = /^(wss?|ircs?):\/\//i.exec(typed)?.[1]?.toLowerCase();
  const rest = scheme ? typed.slice(scheme.length + 3) : typed;
  let host = rest;
  let port: number | null = null;
  let pathAndQuery = "";
  try {
    const parsed = new URL(`http://${rest}`);
    host = parsed.hostname;
    if (parsed.port) port = Number.parseInt(parsed.port, 10);
    pathAndQuery =
      (parsed.pathname === "/" ? "" : parsed.pathname) + parsed.search;
  } catch {
    host = rest.replace(/[:/].*$/, "");
  }
  const isWebSocket =
    scheme === "wss" || scheme === "ws"
      ? true
      : scheme === "ircs" || scheme === "irc"
        ? false
        : useWebSocket;
  const finalPort = port ?? portField;
  if (isWebSocket) return `wss://${host}:${finalPort}${pathAndQuery}`;
  const tcpScheme = scheme === "irc" ? "irc" : "ircs";
  return `${tcpScheme}://${host}:${finalPort}`;
}

/** Whether a typed address names its connection kind. */
export function connectionKindOf(typedHost: string): boolean | undefined {
  const scheme = /^(wss?|ircs?):\/\//i.exec(typedHost.trim())?.[1];
  if (!scheme) return undefined;
  return scheme.toLowerCase().startsWith("ws");
}
