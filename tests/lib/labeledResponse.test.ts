import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { failWhenUnanswered } from "../../src/lib/labeledResponse";

// A message that waits behind others has not reached the server, so it gets
// its full time to answer only once nothing waits any more.
describe("how long an unanswered message stays pending", () => {
  let isWaiting = false;
  const fail = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    fail.mockClear();
    vi.spyOn(ircClient, "hasWaitingLines").mockImplementation(() => isWaiting);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const arm = (waitingAtSend: boolean) => {
    isWaiting = waitingAtSend;
    failWhenUnanswered("s1", fail);
  };
  const elapse = (ms: number, waitingThen: boolean) => {
    vi.advanceTimersByTime(ms - 1);
    isWaiting = waitingThen;
    vi.advanceTimersByTime(1);
  };

  it("fails after thirty seconds when nothing waits", () => {
    arm(false);
    vi.advanceTimersByTime(29_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("gives a message that had to wait one more full period", () => {
    arm(true);
    elapse(30_000, false);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting for as long as lines wait, then one full period more", () => {
    arm(true);
    elapse(30_000, true);
    elapse(30_000, false);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("starts over when lines began to wait after the message was sent", () => {
    arm(false);
    elapse(30_000, true);
    elapse(30_000, false);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
