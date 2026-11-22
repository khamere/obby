// Slippy-map tile math shared by the location preview card. Pure and
// network-free so the geometry is unit-testable without a real tile fetch.

const TILE_SIZE = 256;

// The deepest zoom level the tile server draws, shared by the preview card and
// the interactive maps.
export const MAX_TILE_ZOOM = 19;

// The Web Mercator projection reaches infinity at the poles, so the square
// world map ends at this latitude.
const MAX_MERCATOR_LATITUDE = 85.0511287798;

// Single source of truth for the trusted tile host -- the static preview card
// and the interactive Leaflet map both draw from this template.
export const TILE_URL_TEMPLATE =
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const tileUrl = (z: number, x: number, y: number): string =>
  TILE_URL_TEMPLATE.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));

export interface TilePlacement {
  x: number;
  y: number;
  z: number;
  drawX: number;
  drawY: number;
}

export function worldPixel(
  latitude: number,
  longitude: number,
  zoom: number,
): { x: number; y: number } {
  const scale = 2 ** zoom * TILE_SIZE;
  const x = ((longitude + 180) / 360) * scale;
  const mapLatitude = Math.min(
    MAX_MERCATOR_LATITUDE,
    Math.max(-MAX_MERCATOR_LATITUDE, latitude),
  );
  const latRad = (mapLatitude * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    scale;
  return { x, y };
}

// One copy of the world spans 360 degrees of longitude, and a map dragged past
// the date line reports a position on another copy. This brings such a
// longitude back onto the main copy and leaves one already there as it is.
// The remainder and the single step after it are exact, so the result always
// lands from -180 up to but excluding 180.
export function wrapLongitude(longitude: number): number {
  if (longitude >= -180 && longitude <= 180) return longitude;
  const turn = longitude % 360;
  if (turn >= 180) return turn - 360;
  if (turn < -180) return turn + 360;
  return turn;
}

export interface PreviewGrid {
  left: number;
  top: number;
  firstX: number;
  firstY: number;
  columns: number;
  rows: number;
  tileCount: number;
}

// Where a `width`x`height` crop centred on the position sits in the tile grid.
// The coordinates and zoom can come from a link anyone posted, so we return
// null for values outside the tile grid and never count more columns or rows
// than the crop size can hold.
export function previewGrid(
  latitude: number,
  longitude: number,
  zoom: number,
  width: number,
  height: number = width,
): PreviewGrid | null {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_TILE_ZOOM) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (!Number.isFinite(latitude) || !(Math.abs(longitude) <= 180)) return null;

  const center = worldPixel(latitude, longitude, zoom);
  const left = center.x - width / 2;
  const top = center.y - height / 2;
  const firstX = Math.floor(left / TILE_SIZE);
  const firstY = Math.floor(top / TILE_SIZE);
  const lastX = Math.floor((left + width - 1) / TILE_SIZE);
  const lastY = Math.floor((top + height - 1) / TILE_SIZE);
  return {
    left,
    top,
    firstX,
    firstY,
    columns: Math.min(lastX - firstX + 1, Math.ceil(width / TILE_SIZE) + 1),
    rows: Math.min(lastY - firstY + 1, Math.ceil(height / TILE_SIZE) + 1),
    tileCount: 2 ** zoom,
  };
}

// The tiles needed to cover a `width`x`height` crop centred on the position --
// almost always four, never more than the tile grid itself at very low zoom.
export function tilesForPreview(
  latitude: number,
  longitude: number,
  zoom: number,
  width: number,
  height: number = width,
): TilePlacement[] {
  const grid = previewGrid(latitude, longitude, zoom, width, height);
  if (!grid) return [];
  const { left, top, firstX, firstY, columns, rows, tileCount } = grid;

  const placements: TilePlacement[] = [];
  for (let row = 0; row < rows; row++) {
    const ty = firstY + row;
    if (ty < 0 || ty >= tileCount) continue;
    for (let column = 0; column < columns; column++) {
      const tx = firstX + column;
      placements.push({
        x: ((tx % tileCount) + tileCount) % tileCount,
        y: ty,
        z: zoom,
        drawX: Math.round(tx * TILE_SIZE - left),
        drawY: Math.round(ty * TILE_SIZE - top),
      });
    }
  }
  return placements;
}
