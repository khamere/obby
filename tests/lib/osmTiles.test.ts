import { describe, expect, it } from "vitest";
import {
  MAX_TILE_ZOOM,
  tilesForPreview,
  tileUrl,
  worldPixel,
} from "../../src/lib/osmTiles";

describe("tileUrl", () => {
  it("builds the standard OpenStreetMap tile path", () => {
    expect(tileUrl(14, 4823, 6160)).toBe(
      "https://tile.openstreetmap.org/14/4823/6160.png",
    );
  });
});

describe("worldPixel", () => {
  it("places the prime meridian and equator at the centre of the world map", () => {
    const zoom = 4;
    const { x, y } = worldPixel(0, 0, zoom);
    const worldSize = 256 * 2 ** zoom;
    expect(x).toBeCloseTo(worldSize / 2, 5);
    expect(y).toBeCloseTo(worldSize / 2, 5);
  });

  it("keeps a polar latitude on the map", () => {
    const zoom = 4;
    const worldSize = 256 * 2 ** zoom;
    expect(worldPixel(90, 0, zoom).y).toBeCloseTo(0, 5);
    expect(worldPixel(-90, 0, zoom).y).toBeCloseTo(worldSize, 5);
  });
});

describe("tilesForPreview", () => {
  it("returns between one and four tiles for a normal preview window", () => {
    const placements = tilesForPreview(40.7128, -74.006, 14, 256);
    expect(placements.length).toBeGreaterThanOrEqual(1);
    expect(placements.length).toBeLessThanOrEqual(4);
  });

  it("keeps every tile index inside the zoom level's grid", () => {
    const zoom = 5;
    const tileCount = 2 ** zoom;
    for (const placement of tilesForPreview(51.5, -0.12, zoom, 256)) {
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.x).toBeLessThan(tileCount);
      expect(placement.y).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeLessThan(tileCount);
    }
  });

  it("wraps the tile column across the antimeridian instead of going out of range", () => {
    const zoom = 3;
    const tileCount = 2 ** zoom;
    for (const placement of tilesForPreview(0, 179.999, zoom, 256)) {
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.x).toBeLessThan(tileCount);
    }
  });

  it("draws tiles for a position at a pole", () => {
    for (const latitude of [90, -90, 89.9]) {
      const placements = tilesForPreview(latitude, 10, 14, 320, 180);
      expect(placements.length).toBeGreaterThan(0);
      for (const placement of placements) {
        expect(placement.y).toBeGreaterThanOrEqual(0);
        expect(placement.y).toBeLessThan(2 ** 14);
      }
    }
  });

  it("covers the preview at the deepest zoom level", () => {
    const placements = tilesForPreview(1, 1, MAX_TILE_ZOOM, 320, 180);
    expect(placements.length).toBeGreaterThanOrEqual(1);
    expect(placements.length).toBeLessThanOrEqual(6);
  });

  it.each([
    20,
    53,
    60,
    2000,
    Number.MAX_SAFE_INTEGER,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    -1,
    14.5,
  ])("returns no tiles for zoom %s", (zoom) => {
    expect(tilesForPreview(1, 1, zoom, 320, 180)).toEqual([]);
  });

  it.each([
    [Number.NaN, 1],
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [1, Number.NEGATIVE_INFINITY],
    [1, 1e300],
  ])("returns no tiles for the position %s, %s", (latitude, longitude) => {
    expect(tilesForPreview(latitude, longitude, 14, 320, 180)).toEqual([]);
  });

  it.each([
    [Number.POSITIVE_INFINITY, 180],
    [320, Number.NaN],
    [0, 180],
    [320, -1],
  ])("returns no tiles for a %s by %s preview", (width, height) => {
    expect(tilesForPreview(1, 1, 14, width, height)).toEqual([]);
  });

  it("never returns more tiles than the preview size needs", () => {
    for (let zoom = 0; zoom <= MAX_TILE_ZOOM; zoom++) {
      for (const longitude of [-180, -179.9999, 0, 179.9999, 180]) {
        for (const latitude of [-90, -85, 0, 85, 90]) {
          expect(
            tilesForPreview(latitude, longitude, zoom, 320, 180).length,
          ).toBeLessThanOrEqual(6);
        }
      }
    }
  });
});
