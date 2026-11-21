import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLocationShareUrl,
  describeGeolocationError,
  GeolocationPermissionDeniedError,
  GeolocationTimeoutError,
  getCurrentLocation,
  parseLocationShareUrl,
  roundCoordinate,
} from "../../src/lib/geolocation";

describe("roundCoordinate", () => {
  it("keeps the exact value unrounded", () => {
    expect(roundCoordinate(40.7127837, "exact")).toBe(40.7127837);
  });

  it("rounds an approximate value to three decimal places", () => {
    expect(roundCoordinate(40.7127837, "approximate")).toBe(40.713);
  });

  it("keeps the sign on a southern/western approximate value", () => {
    expect(roundCoordinate(-33.86882, "approximate")).toBe(-33.869);
    expect(roundCoordinate(-74.0059413, "approximate")).toBe(-74.006);
  });
});

describe("buildLocationShareUrl", () => {
  it("builds a well-formed link for an approximate position", () => {
    const url = buildLocationShareUrl(40.7127837, -74.0059413, "approximate");
    expect(url).toBe(
      "https://www.openstreetmap.org/?mlat=40.713&mlon=-74.006#map=14/40.713/-74.006",
    );
  });

  it("builds a well-formed link for an exact position", () => {
    const url = buildLocationShareUrl(40.7127837, -74.0059413, "exact");
    expect(url).toBe(
      "https://www.openstreetmap.org/?mlat=40.7127837&mlon=-74.0059413#map=17/40.7127837/-74.0059413",
    );
  });

  it("keeps the hemisphere sign for a southern/western position", () => {
    const url = buildLocationShareUrl(-33.86882, -70.673676, "approximate");
    expect(url).toBe(
      "https://www.openstreetmap.org/?mlat=-33.869&mlon=-70.674#map=14/-33.869/-70.674",
    );
  });
});

describe("parseLocationShareUrl", () => {
  it("reads coordinates and zoom back out of a built link", () => {
    const url = buildLocationShareUrl(40.7127837, -74.0059413, "exact");
    expect(parseLocationShareUrl(url)).toEqual({
      latitude: 40.7127837,
      longitude: -74.0059413,
      zoom: 17,
    });
  });

  it("keeps the sign for a southern/western link", () => {
    const url = buildLocationShareUrl(-33.86882, -70.673676, "approximate");
    expect(parseLocationShareUrl(url)).toEqual({
      latitude: -33.869,
      longitude: -70.674,
      zoom: 14,
    });
  });

  it("parses a link someone pasted, not just one this app built", () => {
    expect(
      parseLocationShareUrl(
        "https://www.openstreetmap.org/?mlat=51.5074&mlon=-0.1278#map=16/51.5074/-0.1278",
      ),
    ).toEqual({ latitude: 51.5074, longitude: -0.1278, zoom: 16 });
  });

  it("returns null for a bare openstreetmap.org link with no position", () => {
    expect(parseLocationShareUrl("https://www.openstreetmap.org/")).toBeNull();
  });

  it("returns null for an unrelated URL", () => {
    expect(
      parseLocationShareUrl("https://example.com/?mlat=1&mlon=2"),
    ).toBeNull();
  });

  it.each(["60", "2000", "20", "9007199254740993", "9".repeat(400)])(
    "caps the zoom of #map=%s at the deepest tile level",
    (zoom) => {
      expect(
        parseLocationShareUrl(
          `https://www.openstreetmap.org/?mlat=1&mlon=1#map=${zoom}/1/1`,
        ),
      ).toEqual({ latitude: 1, longitude: 1, zoom: 19 });
    },
  );

  it("keeps the zoom levels at both ends of the tile range", () => {
    for (const zoom of [0, 19]) {
      expect(
        parseLocationShareUrl(
          `https://www.openstreetmap.org/?mlat=1&mlon=1#map=${zoom}/1/1`,
        )?.zoom,
      ).toBe(zoom);
    }
  });

  it.each(["-5", "NaN", "Infinity", "14.5", "1e3", ""])(
    "falls back to the default zoom for #map=%s",
    (zoom) => {
      expect(
        parseLocationShareUrl(
          `https://www.openstreetmap.org/?mlat=1&mlon=1#map=${zoom}/1/1`,
        )?.zoom,
      ).toBe(14);
    },
  );

  it.each([
    ["90.0001", "0"],
    ["-91", "0"],
    ["1e300", "0"],
    ["0", "180.0001"],
    ["0", "-181"],
    ["0", "1e300"],
    ["NaN", "0"],
    ["0", "Infinity"],
    ["-Infinity", "0"],
  ])("returns null for the position mlat=%s, mlon=%s", (mlat, mlon) => {
    expect(
      parseLocationShareUrl(
        `https://www.openstreetmap.org/?mlat=${mlat}&mlon=${mlon}#map=14/0/0`,
      ),
    ).toBeNull();
  });

  it("accepts a position on the edge of the coordinate range", () => {
    expect(
      parseLocationShareUrl(
        "https://www.openstreetmap.org/?mlat=-90&mlon=180#map=3/-90/180",
      ),
    ).toEqual({ latitude: -90, longitude: 180, zoom: 3 });
  });
});

describe("describeGeolocationError", () => {
  it("describes a denied permission", () => {
    expect(
      describeGeolocationError(new GeolocationPermissionDeniedError()),
    ).toMatch(/denied/i);
    expect(describeGeolocationError({ code: 1 })).toMatch(/denied/i);
  });

  it("describes a timeout", () => {
    expect(describeGeolocationError(new GeolocationTimeoutError())).toMatch(
      /time/i,
    );
    expect(describeGeolocationError({ code: 3 })).toMatch(/time/i);
  });

  it("falls back to a generic message for anything else", () => {
    expect(describeGeolocationError(new Error("boom"))).toMatch(
      /could not get your location/i,
    );
  });
});

describe("getCurrentLocation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves with the coordinates the browser reports", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) =>
          success({
            coords: { latitude: 1, longitude: 2 },
          } as GeolocationPosition),
      },
    });

    await expect(getCurrentLocation(1000)).resolves.toEqual({
      latitude: 1,
      longitude: 2,
    });
  });

  it("times out rather than waiting forever for a fix that never arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: vi.fn() },
    });

    const result = getCurrentLocation(5000);
    const assertion = expect(result).rejects.toBeInstanceOf(
      GeolocationTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
