import { useSyncExternalStore } from "react";

// A file host the user brings along, for networks that advertise none.
// Zipline (https://zipline.diced.sh) is the reference: POST multipart `file`
// to /api/upload with the account token in the `authorization` header. v3 and
// v4 differ only in the response shape, and both are read here.
//
// Settings live in this browser only. The token lets anyone upload as the
// user, so it never leaves localStorage except in the upload request itself.

const URL_KEY = "obby.userFilehost.url";
const TOKEN_KEY = "obby.userFilehost.token";

export interface UserFilehost {
  /** Origin (plus optional path prefix) of the Zipline instance. */
  url: string;
  token: string;
}

export function isValidFilehostUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** `https://host` or `https://host/zipline/` → that instance's upload endpoint. */
export function ziplineUploadEndpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/api/upload") ? trimmed : `${trimmed}/api/upload`;
}

/**
 * The uploaded file's URL from a Zipline response: v4 `{files:[{url}]}`, v3
 * `{files:["url"]}`. Other self-hosted uploaders answer with a `Location`
 * header, a `url` field or a bare URL, and those are accepted too.
 */
export function parseZiplineResponse(
  location: string | null,
  body: string,
): string | null {
  if (location) return location;
  const text = body.trim();
  try {
    const parsed = JSON.parse(text) as {
      files?: Array<string | { url?: string }>;
      url?: string;
      saved_url?: string;
    };
    const first = parsed.files?.[0];
    if (typeof first === "string" && first) return first;
    if (first && typeof first === "object" && first.url) return first.url;
    const u = parsed.url ?? parsed.saved_url;
    if (u) return u;
    return null;
  } catch {
    // not JSON
  }
  if (/^https?:\/\/\S+$/.test(text)) return text;
  return null;
}

export interface UserFilehostUploadOptions {
  host: UserFilehost;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Upload one file to the user's Zipline. Resolves with the file URL; rejects
 * with a string (not an Error) so the UI can show server text verbatim, like
 * the other uploaders in lib/mediaUpload.
 */
export function uploadToUserFilehost(
  file: File,
  opts: UserFilehostUploadOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      opts.onProgress?.(e.loaded, e.total);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status === 401 || xhr.status === 403) {
        reject("The file host rejected the upload token");
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(xhr.responseText || `${xhr.status} ${xhr.statusText}`);
        return;
      }
      const url = parseZiplineResponse(
        xhr.getResponseHeader("Location"),
        xhr.responseText || "",
      );
      if (url) resolve(url);
      else reject("File host response did not include a URL");
    });
    // From a browser this is usually a blocked CORS preflight: the host has
    // to allow Obby's origin and the authorization header.
    xhr.addEventListener("error", () =>
      reject(
        "Could not reach the file host. It must allow uploads from this site (CORS).",
      ),
    );
    xhr.addEventListener("abort", () => reject("Upload cancelled"));

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject("Upload cancelled");
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort());
    }

    xhr.open("POST", ziplineUploadEndpoint(opts.host.url));
    if (opts.host.token) xhr.setRequestHeader("authorization", opts.host.token);
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

// ---- store ------------------------------------------------------------------

let state: UserFilehost | null = null;
const listeners = new Set<() => void>();

function storageGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage disabled: still applies for this session
  }
}

export function getUserFilehost(): UserFilehost {
  if (!state) {
    state = { url: storageGet(URL_KEY), token: storageGet(TOKEN_KEY) };
  }
  return state;
}

export function setUserFilehost(next: UserFilehost): void {
  const url = next.url.trim().replace(/\/+$/, "");
  // A token without a host is useless and a leftover secret.
  const token = url ? next.token.trim() : "";
  state = { url, token };
  storageSet(URL_KEY, url);
  storageSet(TOKEN_KEY, token);
  for (const l of listeners) l();
}

/** Origin of the configured host, for trusting its media previews. */
export function userFilehostOrigin(): string | null {
  const { url } = getUserFilehost();
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function subscribeUserFilehost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUserFilehost(): UserFilehost {
  return useSyncExternalStore(subscribeUserFilehost, getUserFilehost);
}

// test hook
export function resetUserFilehostForTests(): void {
  state = null;
  listeners.clear();
}
