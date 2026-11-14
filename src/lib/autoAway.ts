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
  // Servers away at this check, so the next one can tell an away that ended since.
  seenAway: Set<string>;
}

export function decideAutoAway({
  minutes,
  idleMs,
  servers,
  ours,
  wasAway = NO_SERVERS,
}: {
  minutes: number;
  idleMs: number;
  servers: readonly AutoAwayServer[];
  ours: ReadonlyMap<string, AutoAwayState>;
  wasAway?: ReadonlySet<string>;
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
  const seenAway = new Set(
    servers.filter((s) => isReady(s) && s.isAway).map((s) => s.id),
  );
  const isIdle = minutes > 0 && idleMs >= minutes * 60_000;
  if (!isIdle) {
    const clearAway: string[] = [];
    for (const [id, state] of next) {
      // A released server waits for the user's input, which a short idle time alone does not prove.
      if (state === "pending" || ours.get(id) === "released") continue;
      if (state === "confirmed") clearAway.push(id);
      next.delete(id);
    }
    return { setAway: [], clearAway, next, seenAway };
  }
  const setAway: string[] = [];
  for (const s of servers) {
    if (!isReady(s) || s.isAway || s.isBouncerControl || next.has(s.id))
      continue;
    // An away that ended while the user was idle was ended from elsewhere.
    if (wasAway.has(s.id)) next.set(s.id, "released");
    else {
      setAway.push(s.id);
      next.set(s.id, "pending");
    }
  }
  return { setAway, clearAway: [], next, seenAway };
}

const NO_SERVERS: ReadonlySet<string> = new Set();

let ours = new Map<string, AutoAwayState>();
let lastSeenAway: ReadonlySet<string> = NO_SERVERS;

export function autoAwaySeenAway(): ReadonlySet<string> {
  return lastSeenAway;
}

export function setAutoAwaySeenAway(seen: ReadonlySet<string>): void {
  lastSeenAway = seen;
}

const expectedBack = new Set<string>();

// The server answers a back we send ourselves, and that answer says nothing about other clients.
export function expectAutoBack(serverId: string): void {
  expectedBack.add(serverId);
}

// A back we did not send ended the away from elsewhere, so we wait for the user.
export function releaseAutoAway(serverId: string): void {
  if (expectedBack.delete(serverId)) return;
  ours.set(serverId, "released");
}

// Input here is the user returning, which ends the wait on every released server.
export function dropReleasedAutoAway(): void {
  for (const [id, state] of ours) if (state === "released") ours.delete(id);
}

// A released server holds no away of ours, so only the other records need the user's input to end.
export function holdsAutoAway(): boolean {
  for (const state of ours.values()) if (state !== "released") return true;
  return false;
}

export function autoAwayRecord(): ReadonlyMap<string, AutoAwayState> {
  return ours;
}

export function setAutoAwayRecord(next: Map<string, AutoAwayState>): void {
  ours = next;
}

// The user's own away or back on a server takes it out of our hands.
export function forgetAutoAway(serverId: string): void {
  ours.delete(serverId);
  expectedBack.delete(serverId);
  if (lastSeenAway.has(serverId))
    lastSeenAway = new Set([...lastSeenAway].filter((id) => id !== serverId));
}
