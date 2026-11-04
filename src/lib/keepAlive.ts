import { invoke } from "@tauri-apps/api/core";
import { isTauriAndroid } from "./platformUtils";

const PLUGIN = "mobile-notifications";

/** Keeps the app process alive behind an ongoing notification, or ends that. */
export async function setKeepAlive(
  enabled: boolean,
  status: string,
  channelName: string,
): Promise<void> {
  if (!isTauriAndroid()) return;
  await invoke(`plugin:${PLUGIN}|set_keep_alive`, {
    enabled,
    status,
    channelName,
  });
}

/** Asks the system to exempt the app from battery optimisation; answers whether it is. */
export async function requestBatteryExemption(): Promise<boolean> {
  if (!isTauriAndroid()) return true;
  const result = await invoke<{ isExempt?: boolean } | null>(
    `plugin:${PLUGIN}|request_battery_exemption`,
  );
  return result?.isExempt === true;
}
