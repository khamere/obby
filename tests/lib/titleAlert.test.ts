import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTitleAlert,
  resetTitleAlertsForTests,
  syncTitleAlert,
} from "../../src/lib/titleAlert";

let focused = false;
let hidden = true;

describe("titleAlert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTitleAlertsForTests();
    document.title = "IRC";
    focused = false;
    hidden = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
  });

  afterEach(() => {
    resetTitleAlertsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("flashes between the alert and the base title while away", () => {
    addTitleAlert("s1", "dm-bob", "bob");
    expect(document.title).toBe("(1) bob messaged you");

    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("(1) IRC");

    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("(1) bob messaged you");
  });

  it("counts messages across conversations", () => {
    addTitleAlert("s1", "dm-bob", "bob");
    addTitleAlert("s1", "chan-1", "alice");
    expect(document.title).toBe("(2) alice messaged you");
  });

  it("keeps a static count once focused on a different conversation", () => {
    addTitleAlert("s1", "dm-bob", "bob");
    focused = true;
    hidden = false;
    syncTitleAlert("s1", "chan-1");
    expect(document.title).toBe("(1) IRC");

    vi.advanceTimersByTime(5000);
    expect(document.title).toBe("(1) IRC");
  });

  it("restores the base title once the conversation is viewed", () => {
    addTitleAlert("s1", "dm-bob", "bob");
    focused = true;
    hidden = false;
    syncTitleAlert("s1", "dm-bob");
    expect(document.title).toBe("IRC");

    vi.advanceTimersByTime(5000);
    expect(document.title).toBe("IRC");
  });

  it("does not count a selected conversation as seen while unfocused", () => {
    addTitleAlert("s1", "dm-bob", "bob");
    syncTitleAlert("s1", "dm-bob");
    expect(document.title).toBe("(1) bob messaged you");
  });
});
