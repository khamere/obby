import { describe, expect, it } from "vitest";
import { followTarget } from "../../src/lib/followTarget";

describe("followTarget", () => {
  it("follows to the end while the New messages line is still below", () => {
    expect(followTarget(500, 900, 700)).toBe(700);
  });

  it("stops with the line at the top while the user is away", () => {
    expect(followTarget(400, 600, 900)).toBe(600);
    expect(followTarget(600, 600, 1000)).toBe(600);
  });

  it("keeps following a reader who scrolled down past the line", () => {
    expect(followTarget(1000, 600, 1200)).toBe(1200);
  });

  it("never scrolls above the top", () => {
    expect(followTarget(0, -48, 300)).toBe(0);
  });
});
