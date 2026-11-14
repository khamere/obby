import { describe, expect, test } from "vitest";
import useStore from "../../src/store";

describe("stripImageMetadata setting", () => {
  test("is on by default", () => {
    expect(useStore.getState().globalSettings.stripImageMetadata).toBe(true);
  });
});
