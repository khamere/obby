// We only ever end an away we set ourselves, so an away the user chose stays until they end it.

export interface AutoAwayServer {
  id: string;
  isConnected: boolean;
  isRegistered?: boolean;
  isAway?: boolean;
  isBouncerControl?: boolean;
}

// pending: sent, not yet confirmed; confirmed: the server marked us away; released: ended from elsewhere, so we wait for the user.
export type AutoAwayState = "pending" | "confirmed" | "released";

export interface AutoAwayDecision {
  setAway: string[];
  clearAway: string[];
  next: Map<string, AutoAwayState>;
}

export function decideAutoAway({
  minutes,
  idleMs,
  servers,
  ours,
}: {
  minutes: number;
  idleMs: number;
  servers: readonly AutoAwayServer[];
  ours: ReadonlyMap<string, AutoAwayState>;
}): AutoAwayDecision {
  // A server accepts AWAY only once our login has finished.
  const isReady = (s: AutoAwayServer) => s.isConnected && s.isRegistered;
  const next = new Map<string, AutoAwayState>();
  for (const [id, state] of ours) {
    const server = servers.find((s) => s.id === id);
    if (!server || !isReady(server)) continue;
    if (state === "released") next.set(id, "released");
    else if (server.isAway) next.set(id, "confirmed");
    else next.set(id, state === "pending" ? "pending" : "released");
  }
  const isIdle = minutes > 0 && idleMs >= minutes * 60_000;
  if (!isIdle) {
    const clearAway: string[] = [];
    for (const [id, state] of next) {
      if (state === "pending") continue;
      if (state === "confirmed") clearAway.push(id);
      next.delete(id);
    }
    return { setAway: [], clearAway, next };
  }
  const setAway = servers
    .filter(
      (s) => isReady(s) && !s.isAway && !s.isBouncerControl && !next.has(s.id),
    )
    .map((s) => s.id);
  for (const id of setAway) next.set(id, "pending");
  return { setAway, clearAway: [], next };
}

let ours = new Map<string, AutoAwayState>();

export function autoAwayRecord(): ReadonlyMap<string, AutoAwayState> {
  return ours;
}

export function setAutoAwayRecord(next: Map<string, AutoAwayState>): void {
  ours = next;
}

// The user's own away or back on a server takes it out of our hands.
export function forgetAutoAway(serverId: string): void {
  ours.delete(serverId);
}
