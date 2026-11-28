import { describe, expect, it } from "vitest";
import "../../src/lib/settings/definitions/allSettings";
import settingsRegistry from "../../src/lib/settings/registry";
import useStore from "../../src/store";

describe("settings registry defaults", () => {
  it("registers the single line fallback with the default the app starts with", () => {
    expect(useStore.getState().globalSettings.autoFallbackToSingleLine).toBe(
      true,
    );
    expect(settingsRegistry.get("preferences.autoFallback")?.defaultValue).toBe(
      true,
    );
  });
});
