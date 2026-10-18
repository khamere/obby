import { beforeEach, describe, expect, test, vi } from "vitest";
import { metadata, ownMetadata, settings } from "../../src/store/localStorage";

describe("settings.load migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockStored(value: object | null): void {
    vi.mocked(window.localStorage.getItem).mockReturnValue(
      value === null ? null : JSON.stringify(value),
    );
  }

  test("returns empty object when nothing is stored", () => {
    mockStored(null);
    const result = settings.load();
    // Migration still runs (no mediaVisibilityLevel in null → defaults to 1)
    expect(result.mediaVisibilityLevel).toBe(1);
  });

  test("migrates showSafeMedia=true to level 1", () => {
    mockStored({ showSafeMedia: true });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(1);
    expect("showSafeMedia" in result).toBe(false);
  });

  test("migrates showSafeMedia=false to level 0", () => {
    mockStored({ showSafeMedia: false });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(0);
    expect("showSafeMedia" in result).toBe(false);
  });

  test("migrates showTrustedSourcesMedia=true to level 2", () => {
    mockStored({
      showSafeMedia: true,
      showTrustedSourcesMedia: true,
      showExternalContent: false,
    });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(2);
    expect("showTrustedSourcesMedia" in result).toBe(false);
  });

  test("migrates showExternalContent=true to level 3", () => {
    mockStored({
      showSafeMedia: true,
      showTrustedSourcesMedia: true,
      showExternalContent: true,
    });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(3);
    expect("showExternalContent" in result).toBe(false);
  });

  test("most-permissive wins: showExternalContent overrides lower flags", () => {
    mockStored({
      showSafeMedia: false,
      showTrustedSourcesMedia: false,
      showExternalContent: true,
    });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(3);
  });

  test("does not migrate if mediaVisibilityLevel already present", () => {
    mockStored({ mediaVisibilityLevel: 2, showSafeMedia: true });
    const result = settings.load();
    expect(result.mediaVisibilityLevel).toBe(2);
    // Old flag is left as-is when not migrating (no need to clean it up)
  });

  test("returns empty object on invalid JSON", () => {
    vi.mocked(window.localStorage.getItem).mockReturnValue("not-json");
    const result = settings.load();
    expect(result).toEqual({});
  });
});

describe("ownMetadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("loads empty object when nothing stored", () => {
    vi.mocked(window.localStorage.getItem).mockReturnValue(null);
    expect(ownMetadata.load()).toEqual({});
  });

  test("saveKey persists metadata and synchronizes in-memory cache", () => {
    const store: Record<string, string> = {};
    vi.mocked(window.localStorage.getItem).mockImplementation(
      (k) => store[k] ?? null,
    );
    vi.mocked(window.localStorage.setItem).mockImplementation((k, v) => {
      store[k] = v;
    });

    ownMetadata.saveKey(
      "srv-1",
      "alice",
      "avatar",
      "https://example.com/avatar.png",
      "public",
    );

    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      "ownUserMetadata",
      expect.stringContaining("https://example.com/avatar.png"),
    );

    const loaded = ownMetadata.getForServer("srv-1", "Alice");
    expect(loaded.avatar).toEqual({
      value: "https://example.com/avatar.png",
      visibility: "public",
    });

    // In-memory cache is also synced
    const memCache = metadata.load();
    expect(memCache["srv-1"]?.alice?.avatar).toEqual({
      value: "https://example.com/avatar.png",
      visibility: "public",
    });
  });

  test("saveKey deletes key when value is undefined or empty", () => {
    const store: Record<string, string> = {};
    vi.mocked(window.localStorage.getItem).mockImplementation(
      (k) => store[k] ?? null,
    );
    vi.mocked(window.localStorage.setItem).mockImplementation((k, v) => {
      store[k] = v;
    });

    ownMetadata.saveKey(
      "srv-1",
      "bob",
      "avatar",
      "https://example.com/b.png",
      "public",
    );
    expect(ownMetadata.getForServer("srv-1", "bob").avatar).toBeDefined();

    ownMetadata.saveKey("srv-1", "bob", "avatar", undefined);
    expect(ownMetadata.getForServer("srv-1", "bob").avatar).toBeUndefined();
  });
});
