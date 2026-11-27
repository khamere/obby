import { classifyInbound } from "../e2ee/classify";

// Servers and bouncers take a few messages at once and then about one every
// two seconds, and a connection that sends faster stops being answered, so we
// send a small burst and then one message per pace.
export const SEND_BURST = 5;
export const SEND_PACE_MS = 2_000;

const MAX_AHEAD_MS = SEND_BURST * SEND_PACE_MS;

// A clock that jumped back would leave the budget spent for as long as the jump, so we cap it at a full burst.
export function capPaidUntil(paidUntil: number, now: number): number {
  return Math.min(paidUntil, now + MAX_AHEAD_MS);
}

function paidAheadMs(paidUntil: number, now: number): number {
  return Math.min(Math.max(paidUntil - now, 0), MAX_AHEAD_MS);
}

export function sendWaitMs(paidUntil: number, now: number): number {
  return Math.max(
    0,
    paidAheadMs(paidUntil, now) - (SEND_BURST - 1) * SEND_PACE_MS,
  );
}

export function chargeSend(paidUntil: number, now: number): number {
  return now + paidAheadMs(paidUntil, now) + SEND_PACE_MS;
}

const BATCH_COMMAND = /^(?:@\S+ )?BATCH [+-]\S/i;
const BATCHED_LINE = /^@(?:[^ ]*;)?batch=/;
const PRIVMSG_BODY = /^(?:@\S+ )?PRIVMSG \S+ :?(.*)$/i;

// A batch keeps its place among the messages but costs nothing, and an
// encrypted frame never waits, because its receiver gives up on a message
// whose frames arrive too far apart.
export function sendLaneKind(line: string): "paced" | "batch" | "free" {
  if (BATCH_COMMAND.test(line) || BATCHED_LINE.test(line)) return "batch";
  const privmsg = PRIVMSG_BODY.exec(line);
  if (!privmsg) return "free";
  return classifyInbound({ body: privmsg[1] }).scheme === "plaintext"
    ? "paced"
    : "free";
}

const LINE_RECEIVER = /^((?:@\S+ )?(?:PRIVMSG|BATCH \+\S+ \S+) )(\S+)/i;

// A line names its receiver by nick, so one that waits has to follow a receiver who changes nick.
export function withReceiverRenamed(
  line: string,
  oldNick: string,
  newNick: string,
): string {
  return line.replace(LINE_RECEIVER, (whole, head: string, receiver: string) =>
    receiver.toLowerCase() === oldNick.toLowerCase() ? head + newNick : whole,
  );
}
