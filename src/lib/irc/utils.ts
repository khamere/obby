export function getNickFromNuh(nuh: string): string {
  const nick = nuh.split("!")[0];
  return nick.startsWith(":") ? nick.substring(1) : nick;
}

export function getUserFromNuh(nuh: string): string {
  const withoutColon = nuh.startsWith(":") ? nuh.substring(1) : nuh;
  const afterBang = withoutColon.split("!")[1] ?? "";
  return afterBang.split("@")[0];
}

export function getHostFromNuh(nuh: string): string {
  const withoutColon = nuh.startsWith(":") ? nuh.substring(1) : nuh;
  return withoutColon.split("@")[1] ?? "";
}

const SERVER_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const OLDEST_SERVER_TIME = Date.UTC(1988, 0, 1);
const SERVER_TIME_AHEAD_MS = 366 * 86_400_000;

// A server-time tag is a full UTC date and time ending in Z, and the fraction of a second may be left out or run past milliseconds.
// We read nothing else as a time, since a looser reader takes a bare number for a year, and a time before IRC existed or far ahead of our clock is no time a line was sent at.
export function parseServerTime(
  value: string | undefined,
  now: number = Date.now(),
): number {
  const match = value ? SERVER_TIME.exec(value) : null;
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, sentSecond] = match
    .slice(1, 7)
    .map(Number);
  // Our clock has no leap second, so we read one as the last millisecond of its minute, which keeps it in order and inside that minute.
  const isLeapSecond = sentSecond === 60;
  const second = isLeapSecond ? 59 : sentSecond;
  const ms = isLeapSecond
    ? 999
    : Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const time = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const date = new Date(time);
  const isOnCalendar =
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  const isPlausible =
    time >= OLDEST_SERVER_TIME && time <= now + SERVER_TIME_AHEAD_MS;
  return isOnCalendar && isPlausible ? time : Number.NaN;
}

export function getTimestampFromTags(
  mtags: Record<string, string> | undefined,
): Date {
  const time = parseServerTime(mtags?.time);
  return Number.isNaN(time) ? new Date() : new Date(time);
}
