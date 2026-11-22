import { t } from "@lingui/core/macro";
import {
  checkPermissions as checkNativePermissions,
  getCurrentPosition as getNativePosition,
  requestPermissions as requestNativePermissions,
} from "@tauri-apps/plugin-geolocation";
import { MAX_TILE_ZOOM, wrapLongitude } from "./osmTiles";
import { isTauriDesktop, isTauriMobile } from "./platformUtils";

export type LocationPrecision = "exact" | "approximate";

export interface Coordinates {
  latitude: number;
  longitude: number;
}

// 3 decimal places is about 111m at the equator -- enough to blur which
// building someone is in while still placing them in their neighbourhood.
const APPROXIMATE_DECIMALS = 3;

export const EXACT_ZOOM = 17;
export const APPROXIMATE_ZOOM = 14;

const DEFAULT_TIMEOUT_MS = 15_000;

export function roundCoordinate(
  value: number,
  precision: LocationPrecision,
): number {
  if (precision === "exact") return value;
  return Number(value.toFixed(APPROXIMATE_DECIMALS));
}

// A plain OpenStreetMap link: readable in any IRC client and opens in the
// reader's own browser or map app, so nothing in this app ever has to fetch
// a tile on the reader's behalf.
export function buildLocationShareUrl(
  latitude: number,
  longitude: number,
  precision: LocationPrecision,
  zoom?: number,
): string {
  const lat = roundCoordinate(latitude, precision);
  const lon = roundCoordinate(wrapLongitude(longitude), precision);
  const mapZoom =
    zoom ?? (precision === "exact" ? EXACT_ZOOM : APPROXIMATE_ZOOM);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${mapZoom}/${lat}/${lon}`;
}

export interface ParsedLocationUrl {
  latitude: number;
  longitude: number;
  zoom: number;
}

function readPositionParams(
  url: string,
): { parsed: URL; mlat: string | null; mlon: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.replace(/^www\./, "") !== "openstreetmap.org") {
    return null;
  }
  return {
    parsed,
    mlat: parsed.searchParams.get("mlat"),
    mlon: parsed.searchParams.get("mlon"),
  };
}

// The inverse of buildLocationShareUrl. Reads mlat/mlon out of the URL
// itself, so the preview reflects whatever precision the link was built
// with -- our own share button's, or one a person simply pasted. Anyone can
// post such a link, so we only return a position that exists on the globe and
// a zoom level the tile server has.
export function parseLocationShareUrl(url: string): ParsedLocationUrl | null {
  const params = readPositionParams(url);
  if (!params) return null;
  const { parsed, mlat, mlon } = params;
  if (mlat === null || mlon === null) return null;
  // An empty value converts to zero, which would place the pin off the coast
  // of Africa for a link that names no position.
  if (mlat.trim() === "" || mlon.trim() === "") return null;
  const latitude = Number(mlat);
  // A map dragged across the date line names a longitude on another copy of
  // the world, so any finite longitude is a place on the main one.
  const worldCopyLongitude = Number(mlon);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (!Number.isFinite(worldCopyLongitude)) return null;

  const fragmentZoom = parsed.hash.match(/#map=(\d+)\//)?.[1];
  const zoom = fragmentZoom
    ? Math.min(MAX_TILE_ZOOM, Number(fragmentZoom))
    : APPROXIMATE_ZOOM;
  return { latitude, longitude: wrapLongitude(worldCopyLongitude), zoom };
}

// A map link that carries a position we refuse to draw. It stays a plain link:
// its address holds whatever the sender typed, so we never request it.
export function isRejectedLocationShareUrl(url: string): boolean {
  const params = readPositionParams(url);
  if (!params || (params.mlat === null && params.mlon === null)) return false;
  return parseLocationShareUrl(url) === null;
}

// The plugin behind this is Android/iOS only (no desktop implementation),
// and the macOS webview exposes no geolocation API of its own, so the entry
// point must be absent on desktop rather than present and broken there.
export function locationSharingSupported(): boolean {
  if (isTauriDesktop()) return false;
  if (isTauriMobile()) return true;
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

export class GeolocationTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for a location fix.");
    this.name = "GeolocationTimeoutError";
  }
}

export class GeolocationPermissionDeniedError extends Error {
  constructor() {
    super("Location permission was denied.");
    this.name = "GeolocationPermissionDeniedError";
  }
}

function errorCode(err: unknown): number | null {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "number"
  ) {
    return (err as { code: number }).code;
  }
  return null;
}

// Web's GeolocationPositionError codes: 1 PERMISSION_DENIED, 2
// POSITION_UNAVAILABLE, 3 TIMEOUT. The native plugin checks permission
// state up front instead of surfacing a matching code, so that path is
// caught above via GeolocationPermissionDeniedError.
export function describeGeolocationError(err: unknown): string {
  if (err instanceof GeolocationPermissionDeniedError || errorCode(err) === 1) {
    return t`Location access was denied. Allow location access in your browser or system settings, then try again.`;
  }
  if (err instanceof GeolocationTimeoutError || errorCode(err) === 3) {
    return t`Could not find your location in time. Try again somewhere with a clearer view of the sky.`;
  }
  if (errorCode(err) === 2) {
    return t`This device could not find your location right now. Try again in a moment.`;
  }
  return t`Could not get your location.`;
}

function getCurrentPositionWeb(): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not available."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      reject,
      { enableHighAccuracy: true },
    );
  });
}

async function getCurrentPositionNative(): Promise<Coordinates> {
  let permissions = await checkNativePermissions();
  if (
    permissions.location === "prompt" ||
    permissions.location === "prompt-with-rationale"
  ) {
    permissions = await requestNativePermissions(["location"]);
  }
  if (permissions.location !== "granted") {
    throw new GeolocationPermissionDeniedError();
  }
  const position = await getNativePosition();
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  };
}

// The plugin's own timeout option is ignored on iOS entirely and ignored by
// getCurrentPosition on Android, so a device that never gets a fix would
// leave the caller waiting forever without a timer of our own.
export function getCurrentLocation(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Coordinates> {
  const capture = isTauriMobile()
    ? getCurrentPositionNative()
    : getCurrentPositionWeb();
  return Promise.race([
    capture,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new GeolocationTimeoutError()), timeoutMs);
    }),
  ]);
}
