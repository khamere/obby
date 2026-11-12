import { describe, expect, it } from "vitest";
import { followTarget, isPastUnreadLine } from "../../src/lib/followTarget";

describe("followTarget", () => {
  it("follows to the end while the New messages line is still below", () => {
    expect(followTarget(900, 700, false)).toBe(700);
  });

  it("stops with the line at the top while the user is away", () => {
    expect(followTarget(600, 900, false)).toBe(600);
  });

  it("stops at the line when trimmed rows above move it up", () => {
    // The view sits at the end and the line moved up by a dropped row.
    expect(followTarget(8952, 9001, false)).toBe(8952);
  });

  it("keeps following a reader who scrolled past the line", () => {
    expect(followTarget(600, 1200, true)).toBe(1200);
  });

  it("never scrolls above the top", () => {
    expect(followTarget(-48, 300, false)).toBe(0);
  });
});

describe("isPastUnreadLine", () => {
  it("counts a line the reader scrolled above the stop point", () => {
    expect(isPastUnreadLine(-200, 48)).toBe(true);
    expect(isPastUnreadLine(10, 48)).toBe(true);
  });

  it("leaves a line resting at the stop point or below it", () => {
    expect(isPastUnreadLine(48, 48)).toBe(false);
    expect(isPastUnreadLine(300, 48)).toBe(false);
  });

  it("is false without a line", () => {
    expect(isPastUnreadLine(null, 48)).toBe(false);
  });
});
