import type { SearchQuery } from "./searchTypes";

const SEARCHES_KEY = "obsidian.search.recentSearches";
const PLACES_KEY = "obsidian.search.recentPlaces";
const MAX_SEARCHES = 10;
const MAX_PLACES = 8;

export interface RecentPlace {
  serverId: string;
  name: string;
  kind: "channel" | "dm";
}

// Storage can be full, disabled or hold junk, and recents are never worth an error.
function readList<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, list: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    return;
  }
}

function pushRecent<T>(key: string, item: T, max: number): void {
  const id = JSON.stringify(item);
  const rest = readList<T>(key).filter((old) => JSON.stringify(old) !== id);
  writeList(key, [item, ...rest].slice(0, max));
}

export const getRecentSearches = (): SearchQuery[] =>
  readList<SearchQuery>(SEARCHES_KEY);

export const recordSearch = (query: SearchQuery): void =>
  pushRecent(SEARCHES_KEY, query, MAX_SEARCHES);

export const getRecentPlaces = (): RecentPlace[] =>
  readList<RecentPlace>(PLACES_KEY);

export const recordPlace = (place: RecentPlace): void =>
  pushRecent(PLACES_KEY, place, MAX_PLACES);

// A renamed channel keeps its entry, so the list never offers a name the server no longer has.
export function renameRecentPlace(
  serverId: string,
  oldName: string,
  newName: string,
): void {
  const places = getRecentPlaces();
  const isRenamed = (place: RecentPlace) =>
    place.serverId === serverId &&
    place.kind === "channel" &&
    place.name.toLowerCase() === oldName.toLowerCase();
  if (!places.some(isRenamed)) return;
  writeList(
    PLACES_KEY,
    places.map((place) =>
      isRenamed(place) ? { ...place, name: newName } : place,
    ),
  );
}

export const clearRecentSearches = (): void => writeList(SEARCHES_KEY, []);

export function clearRecents(): void {
  clearRecentSearches();
  writeList(PLACES_KEY, []);
}
