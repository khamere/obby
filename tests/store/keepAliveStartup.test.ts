import { describe, expect, it, vi } from "vitest";

// The store, and with it the keep-alive handler, is created when the store
// module loads, before main.tsx activates the locale. On Android that must
// not translate anything, or the app never starts.
describe("keep-alive at app start", () => {
  it("creates the store on Android before any locale is active", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/platformUtils", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      isTauriAndroid: () => true,
      isTauri: () => true,
    }));
    vi.doMock("../../src/lib/keepAlive", () => ({
      setKeepAlive: vi.fn(() => Promise.resolve()),
      requestBatteryExemption: vi.fn(() => Promise.resolve(true)),
    }));
    // Lingui throws for any translation before activate(); the shared setup
    // has activated a locale, so the throw is restored here for the import.
    const { i18n } = await import("@lingui/core");
    const translate = vi.spyOn(i18n, "_").mockImplementation(() => {
      throw new Error("Lingui: translation before activate");
    });
    try {
      await expect(import("../../src/store")).resolves.toBeTruthy();
      expect(translate).not.toHaveBeenCalled();
    } finally {
      translate.mockRestore();
      vi.doUnmock("../../src/lib/platformUtils");
      vi.doUnmock("../../src/lib/keepAlive");
    }
  });
});
