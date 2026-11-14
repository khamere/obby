// Auto away marks the user away on every connected server after a stretch
// without input, and back on their next input. We only ever undo an away we
// set ourselves, so an away the user chose stays until they end it.

export interface AutoAwayServer {
  id: string;
  isConnected: boolean;
  isRegistered?: boolean;
  isAway?: boolean;
  isBouncerControl?: boolean;
}

export type AutoAwayState = "pending" | "confirmed";

export interface AutoAwayDecision {
  setAway: string[];
  clearAway: string[];
  // Our record after this pass: a server's own reply confirms an away we
  // sent, and an away ended some other way is no longer ours.
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
    if (server.isAway) next.set(id, "confirmed");
    else if (state === "pending") next.set(id, "pending");
  }
  const isIdle = minutes > 0 && idleMs >= minutes * 60_000;
  if (!isIdle) {
    const clearAway = [...next]
      .filter(([, state]) => state === "confirmed")
      .map(([id]) => id);
    for (const id of clearAway) next.delete(id);
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
