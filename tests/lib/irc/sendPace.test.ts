import { describe, expect, it } from "vitest";
import {
  capPaidUntil,
  chargeSend,
  sendLaneKind,
  sendWaitMs,
} from "../../../src/lib/irc/sendPace";

describe("the send clock", () => {
  it("lets a burst of five leave at once", () => {
    expect(sendWaitMs(0, 1000)).toBe(0);
    expect(sendWaitMs(9000, 1000)).toBe(0);
  });

  it("holds the sixth line for one pace", () => {
    expect(sendWaitMs(11_000, 1000)).toBe(2000);
  });

  it("fills the window with five charges", () => {
    let paidUntil = 0;
    for (let sent = 0; sent < 5; sent++)
      paidUntil = chargeSend(paidUntil, 1000);
    expect(paidUntil).toBe(11_000);
  });

  it("never asks for more than one pace, however far the budget is spent", () => {
    expect(sendWaitMs(3_600_000, 1000)).toBe(2000);
  });

  it("gives the whole burst back after ten idle seconds", () => {
    expect(sendWaitMs(10_000, 62_000)).toBe(0);
  });

  it("caps a budget left far ahead by a clock that jumped back", () => {
    expect(capPaidUntil(110_000, 0)).toBe(10_000);
    expect(capPaidUntil(9000, 1000)).toBe(9000);
  });
});

describe("which lines wait for their turn", () => {
  it.each([
    "PRIVMSG #a :hi",
    "@+reply=x;label=y PRIVMSG #a :hi",
    "privmsg #a hi",
    "PRIVMSG #a :\u0001ACTION waves\u0001",
  ])("paces the plain message %j", (line) => {
    expect(sendLaneKind(line)).toBe("paced");
  });

  it.each([
    "@batch=b PRIVMSG #a :x",
    "@batch=b;draft/multiline-concat PRIVMSG #a :x",
    "@+reply=x BATCH +b draft/multiline #a",
    "BATCH -b",
  ])("keeps the batch line %j in order at no cost", (line) => {
    expect(sendLaneKind(line)).toBe("batch");
  });

  it.each([
    "PING :1",
    "@+typing=active TAGMSG #a",
    "NOTICE n :x",
    "JOIN #a",
    "@+obby.world/e2ee=AAAA PRIVMSG bob :?obe2ee:",
    "PRIVMSG bob :?OTR:AAAA.",
  ])("never holds %j", (line) => {
    expect(sendLaneKind(line)).toBe("free");
  });
});
