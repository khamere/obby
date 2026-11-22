import { describe, expect, it } from "vitest";
import {
  MAX_TILE_ZOOM,
  previewGrid,
  tilesForPreview,
  tileUrl,
  worldPixel,
  wrapLongitude,
} from "../../src/lib/osmTiles";

// A tile loop that runs away cannot be interrupted by the test runner, so
// every case built from a hostile value checks the grid arithmetic, which has
// no loop, and only then asks for the tiles.
function expectNoGrid(
  latitude: number,
  longitude: number,
  zoom: number,
  width: number,
  height: number,
) {
  expect(previewGrid(latitude, longitude, zoom, width, height)).toBeNull();
  expect(tilesForPreview(latitude, longitude, zoom, width, height)).toEqual([]);
}

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

describe("wrapLongitude", () => {
  it("leaves a longitude on the main copy of the world alone", () => {
    for (const longitude of [
      -180, -179.99999999999997, -74.0059413, 0, 2.3, 179.999,
      179.99999999999997, 180,
    ]) {
      expect(wrapLongitude(longitude)).toBe(longitude);
    }
  });

  it("brings a longitude from a neighbouring copy back onto the main one", () => {
    expect(wrapLongitude(187.438)).toBe(-172.562);
    expect(wrapLongitude(-187.438)).toBe(172.562);
    expect(wrapLongitude(180.00000000000003)).toBe(-179.99999999999997);
    expect(wrapLongitude(-180.00000000000003)).toBe(179.99999999999997);
    expect(wrapLongitude(540)).toBe(-180);
    expect(wrapLongitude(-540)).toBe(-180);
    expect(wrapLongitude(541)).toBe(-179);
    expect(wrapLongitude(360)).toBe(0);
  });

  it("puts every finite longitude where the tile grid can draw it", () => {
    for (const longitude of [
      1e300,
      -1e300,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      2 ** 53 + 2,
      719.9999999999999,
      -539.9999999999999,
      -180.00000000000003,
    ]) {
      const wrapped = wrapLongitude(longitude);
      expect(wrapped).toBeGreaterThanOrEqual(-180);
      expect(wrapped).toBeLessThan(180);
      const grid = previewGrid(1, wrapped, 14, 320, 180);
      expect(grid).not.toBeNull();
      expect(grid?.columns).toBeLessThanOrEqual(3);
      expect(grid?.rows).toBeLessThanOrEqual(2);
      expect(tilesForPreview(1, wrapped, 14, 320, 180).length).toBeGreaterThan(
        0,
      );
    }
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
      const grid = previewGrid(latitude, 10, 14, 320, 180);
      expect(grid?.columns).toBeLessThanOrEqual(3);
      expect(grid?.rows).toBeLessThanOrEqual(2);
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
    expectNoGrid(1, 1, zoom, 320, 180);
  });

  it.each([
    [Number.NaN, 1],
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [1, Number.NEGATIVE_INFINITY],
    [1, 1e300],
    [1, 180.0001],
    [1, -180.00000000000003],
    [1, -187.438],
  ])("returns no tiles for the position %s, %s", (latitude, longitude) => {
    expectNoGrid(latitude, longitude, 14, 320, 180);
  });

  it.each([
    [Number.POSITIVE_INFINITY, 180],
    [320, Number.NaN],
    [0, 180],
    [320, -1],
  ])("returns no tiles for a %s by %s preview", (width, height) => {
    expectNoGrid(1, 1, 14, width, height);
  });

  it("never returns more tiles than the preview size needs", () => {
    for (let zoom = 0; zoom <= MAX_TILE_ZOOM; zoom++) {
      for (const longitude of [-180, -179.9999, 0, 179.9999, 180]) {
        for (const latitude of [-90, -85, 0, 85, 90]) {
          const grid = previewGrid(latitude, longitude, zoom, 320, 180);
          expect(grid).not.toBeNull();
          expect(grid?.columns).toBeLessThanOrEqual(3);
          expect(grid?.rows).toBeLessThanOrEqual(2);
          expect(
            tilesForPreview(latitude, longitude, zoom, 320, 180).length,
          ).toBeLessThanOrEqual(6);
        }
      }
    }
  });

  it("repeats the single tile of zoom 0 across the card", () => {
    const grid = previewGrid(0, 0, 0, 320, 180);
    expect(grid?.columns).toBe(3);
    expect(grid?.rows).toBe(1);
    const placements = tilesForPreview(0, 0, 0, 320, 180);
    expect(placements.map((p) => `${p.z}/${p.x}/${p.y}`)).toEqual([
      "0/0/0",
      "0/0/0",
      "0/0/0",
    ]);
    expect(new Set(placements.map((p) => p.drawX)).size).toBe(3);
  });
});
