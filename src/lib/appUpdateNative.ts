import {
  addPluginListener,
  invoke,
  type PluginListener,
} from "@tauri-apps/api/core";
import { RELEASES_API } from "./releaseCheck";

export type UpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "waiting-foreground"
  | "needs-permission"
  | "installing"
  | "error";

export type UpdateError =
  | "network"
  | "no-apk"
  | "checksum"
  | "incompatible"
  | "refused"
  | "storage";

export interface NativeUpdateEvent {
  phase: UpdatePhase;
  received: number;
  total: number;
  error: UpdateError | null;
}

export interface StartDownloadArgs {
  url: string;
  sha256: string;
  size: number;
  version: string;
  allowedHosts: string[];
}

export const startDownload = (args: StartDownloadArgs) =>
  invoke<NativeUpdateEvent>("plugin:app-update|start_download", { ...args });

export const cancelDownload = () =>
  invoke<void>("plugin:app-update|cancel_download");

export const downloadStatus = () =>
  invoke<NativeUpdateEvent>("plugin:app-update|download_status");

export const openInstallSettings = () =>
  invoke<void>("plugin:app-update|open_install_settings");

export const retryInstall = () =>
  invoke<NativeUpdateEvent>("plugin:app-update|retry_install");

export const onUpdateEvent = (
  cb: (e: NativeUpdateEvent) => void,
): Promise<PluginListener> => addPluginListener("app-update", "update", cb);

/**
 * Hosts the plugin may download from, so a release page cannot point it
 * elsewhere. A leading dot means "any host ending in this"; the API's own
 * host is included so a test build can serve its own files.
 */
export function allowedUpdateHosts(api: string = RELEASES_API): string[] {
  const hosts = ["github.com", ".githubusercontent.com"];
  try {
    const host = new URL(api).hostname;
    if (host && !hosts.includes(host)) hosts.push(host);
  } catch {
    // an unparsable API base adds nothing
  }
  return hosts;
}
