import { describe, expect, it } from "vitest";
import "../../src/lib/settings/definitions/allSettings";
import settingsRegistry from "../../src/lib/settings/registry";

describe("settingsRegistry search", () => {
  it("finds the microphone, camera, and speaker settings independently", () => {
    expect(settingsRegistry.search("microphone")[0]?.setting.id).toBe(
      "calls.microphone",
    );
    expect(settingsRegistry.search("camera")[0]?.setting.id).toBe(
      "calls.camera",
    );
    expect(settingsRegistry.search("speaker")[0]?.setting.id).toBe(
      "calls.speaker",
    );
  });

  it("finds the single line fallback by what it does to a message", () => {
    const ids = (query: string) =>
      settingsRegistry.search(query).map((result) => result.setting.id);

    expect(ids("spaces")).toContain("preferences.autoFallback");
    expect(ids("short messages")).not.toContain("preferences.autoFallback");
  });
});
