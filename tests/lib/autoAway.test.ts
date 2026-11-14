import { describe, expect, it } from "vitest";
import { type AutoAwayState, decideAutoAway } from "../../src/lib/autoAway";

const MIN = 60_000;
const server = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  isConnected: true,
  isAway: false,
  ...extra,
});
const ours = (entries: [string, AutoAwayState][] = []) => new Map(entries);

describe("decideAutoAway", () => {
  it("marks every connected server away once the idle time passes", () => {
    const d = decideAutoAway({
      minutes: 10,
      idleMs: 10 * MIN,
      servers: [server("a"), server("b"), server("c", { isConnected: false })],
      ours: ours(),
    });
    expect(d.setAway).toEqual(["a", "b"]);
    expect([...d.next]).toEqual([
      ["a", "pending"],
      ["b", "pending"],
    ]);
  });

  it("does nothing before the idle time passes", () => {
    const d = decideAutoAway({
      minutes: 10,
      idleMs: 9 * MIN,
      servers: [server("a")],
      ours: ours(),
    });
    expect(d.setAway).toEqual([]);
    expect(d.clearAway).toEqual([]);
  });

  it("does nothing while switched off", () => {
    const d = decideAutoAway({
      minutes: 0,
      idleMs: 600 * MIN,
      servers: [server("a")],
      ours: ours(),
    });
    expect(d.setAway).toEqual([]);
  });

  it("leaves a server the user already marked away alone", () => {
    const d = decideAutoAway({
      minutes: 5,
      idleMs: 60 * MIN,
      servers: [server("a", { isAway: true })],
      ours: ours(),
    });
    expect(d.setAway).toEqual([]);
    expect(d.next.size).toBe(0);

    const back = decideAutoAway({
      minutes: 5,
      idleMs: 0,
      servers: [server("a", { isAway: true })],
      ours: d.next,
    });
    expect(back.clearAway).toEqual([]);
  });

  it("skips the bouncer's own control connection", () => {
    const d = decideAutoAway({
      minutes: 5,
      idleMs: 5 * MIN,
      servers: [server("ctl", { isBouncerControl: true })],
      ours: ours(),
    });
    expect(d.setAway).toEqual([]);
  });

  it("sends away once while the server has not answered yet", () => {
    const d = decideAutoAway({
      minutes: 5,
      idleMs: 6 * MIN,
      servers: [server("a")],
      ours: ours([["a", "pending"]]),
    });
    expect(d.setAway).toEqual([]);
    expect(d.next.get("a")).toBe("pending");
  });

  it("marks the user back on activity, once the server confirmed the away", () => {
    const confirmed = decideAutoAway({
      minutes: 5,
      idleMs: 6 * MIN,
      servers: [server("a", { isAway: true })],
      ours: ours([["a", "pending"]]),
    });
    expect(confirmed.next.get("a")).toBe("confirmed");

    const back = decideAutoAway({
      minutes: 5,
      idleMs: 0,
      servers: [server("a", { isAway: true })],
      ours: confirmed.next,
    });
    expect(back.clearAway).toEqual(["a"]);
    expect(back.next.size).toBe(0);
  });

  it("marks the user back when auto away is switched off while away", () => {
    const d = decideAutoAway({
      minutes: 0,
      idleMs: 60 * MIN,
      servers: [server("a", { isAway: true })],
      ours: ours([["a", "confirmed"]]),
    });
    expect(d.clearAway).toEqual(["a"]);
  });

  it("forgets an away that ended some other way", () => {
    const d = decideAutoAway({
      minutes: 5,
      idleMs: 0,
      servers: [server("a", { isAway: false })],
      ours: ours([["a", "confirmed"]]),
    });
    expect(d.clearAway).toEqual([]);
    expect(d.next.size).toBe(0);
  });

  it("forgets a server that disconnected", () => {
    const d = decideAutoAway({
      minutes: 5,
      idleMs: 0,
      servers: [server("a", { isConnected: false, isAway: true })],
      ours: ours([["a", "confirmed"]]),
    });
    expect(d.clearAway).toEqual([]);
    expect(d.next.size).toBe(0);
  });
});
