import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

const serverId = "s1";

const stored = () => JSON.parse(lsBacking.get("drafts") ?? "null");

// The app starts when the store module loads, so each start loads a fresh copy of it over what storage holds.
async function startApp() {
  vi.resetModules();
  await import("../../src/store");
  return import("../../src/lib/drafts");
}

describe("drafts across a page reload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installLocalStorageBacking();
    lsBacking.set("savedServers", JSON.stringify([{ id: serverId }]));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    lsBacking.clear();
  });

  it("brings back text typed just before the page is unloaded", async () => {
    const session = await startApp();
    session.setDraft(serverId, "#chan", "hello wor");
    expect(stored()).toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    expect(stored()[serverId]["#chan"].text).toBe("hello wor");

    const reloaded = await startApp();
    expect(reloaded.getDraft(serverId, "#chan")).toBe("hello wor");
  });

  it("writes the draft when the page is hidden, since a hidden page may be evicted", async () => {
    const session = await startApp();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    session.setDraft(serverId, "#chan", "hello wor");

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stored()).toBeNull();

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stored()[serverId]["#chan"].text).toBe("hello wor");
  });
});
