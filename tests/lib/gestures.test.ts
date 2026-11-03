import { afterEach, describe, expect, it } from "vitest";
import { isGestureClaimed } from "../../src/lib/gestures";

const sized = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
};

describe("isGestureClaimed", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("claims a touch inside a block that scrolls sideways", () => {
    document.body.innerHTML =
      '<div id="box" style="overflow-x: auto"><span id="t">art</span></div>';
    const box = document.getElementById("box") as HTMLElement;
    sized(box, 800, 360);
    expect(isGestureClaimed(document.getElementById("t"))).toBe(true);
  });

  it("leaves a scroller alone that has nothing to scroll", () => {
    document.body.innerHTML =
      '<div id="box" style="overflow-x: auto"><span id="t">short</span></div>';
    sized(document.getElementById("box") as HTMLElement, 360, 360);
    expect(isGestureClaimed(document.getElementById("t"))).toBe(false);
  });

  it("ignores overflow that is clipped rather than scrollable", () => {
    document.body.innerHTML =
      '<div id="box" style="overflow-x: hidden"><span id="t">wide</span></div>';
    sized(document.getElementById("box") as HTMLElement, 800, 360);
    expect(isGestureClaimed(document.getElementById("t"))).toBe(false);
  });

  it("still honours data-no-gesture and tolerates odd targets", () => {
    document.body.innerHTML = '<div data-no-gesture=""><b id="t">x</b></div>';
    expect(isGestureClaimed(document.getElementById("t"))).toBe(true);
    expect(isGestureClaimed(null)).toBe(false);
    expect(isGestureClaimed({} as EventTarget)).toBe(false);
  });
});
