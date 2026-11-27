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

  it.each(["whitelist", "domain", "allowed"])(
    "finds the allowed media sites by %j",
    (query) => {
      expect(settingsRegistry.search(query).map((r) => r.setting.id)).toContain(
        "media.allowedHosts",
      );
    },
  );
});
