import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted as tauriIsPermissionGranted,
  requestPermission as tauriRequestPermission,
  sendNotification as tauriSendNotification,
} from "@tauri-apps/plugin-notification";
import type { GlobalSettings } from "../store";
import type { User } from "../types";
import { containsWholeWord } from "./nickHighlight";
import { isTauri } from "./platformUtils";

const serverVapidKeys = new Map<string, string>();
let pendingPushSubscription: Promise<PushSubscription | null> | null = null;
const retriedWebPushServers = new Set<string>();

export const clearWebPushRetry = (serverId?: string): void => {
  if (serverId) {
    retriedWebPushServers.delete(serverId);
  } else {
    retriedWebPushServers.clear();
  }
};

function hasMatchingApplicationServerKey(
  existing: PushSubscription,
  expectedKey: Uint8Array,
): boolean {
  const currentKey = existing.options?.applicationServerKey;
  if (!currentKey) {
    return false;
  }
  const currentBytes = new Uint8Array(currentKey);
  if (currentBytes.byteLength !== expectedKey.byteLength) return false;
  for (let i = 0; i < expectedKey.byteLength; i++) {
    if (currentBytes[i] !== expectedKey[i]) return false;
  }
  return true;
}

async function getOrCreatePushSubscription(
  registration: ServiceWorkerRegistration,
  vapidKey: string,
  forceRefresh = false,
  onStaleEndpoint?: (endpoint: string) => void,
): Promise<PushSubscription | null> {
  if (pendingPushSubscription && !forceRefresh) {
    return pendingPushSubscription;
  }
  pendingPushSubscription = (async () => {
    try {
      const appServerKey = urlBase64ToUint8Array(vapidKey);
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        if (
          !forceRefresh &&
          hasMatchingApplicationServerKey(existing, appServerKey)
        ) {
          return existing;
        }
        if (existing.endpoint && onStaleEndpoint) {
          onStaleEndpoint(existing.endpoint);
        }
        if (typeof existing.unsubscribe === "function") {
          try {
            await existing.unsubscribe();
          } catch (unsubErr) {
            console.warn(
              "[WebPush] Failed to unsubscribe stale subscription:",
              unsubErr,
            );
          }
        }
      }
      return await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey.buffer as ArrayBuffer,
      });
    } finally {
      pendingPushSubscription = null;
    }
  })();
  return pendingPushSubscription;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Retry WebPush registration with a fresh push subscription if the server
 * rejected the previous endpoint as invalid.
 */
export const retryWebPushRegistrationOnFailure = async (
  serverId: string,
  sendRaw: (serverId: string, line: string) => void,
): Promise<void> => {
  if (retriedWebPushServers.has(serverId)) {
    return;
  }
  retriedWebPushServers.add(serverId);

  const vapidKey = serverVapidKeys.get(serverId);
  if (!vapidKey) return;
  if (isTauri()) return;
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (!("PushManager" in window)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const newSub = await getOrCreatePushSubscription(
      registration,
      vapidKey,
      true,
      (staleEndpoint) => {
        sendRaw(serverId, `WEBPUSH UNREGISTER ${staleEndpoint}`);
      },
    );
    if (!newSub) return;
    const json = newSub.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (newSub.endpoint && p256dh && auth) {
      sendRaw(
        serverId,
        `WEBPUSH REGISTER ${newSub.endpoint} p256dh=${p256dh};auth=${auth}`,
      );
    }
  } catch (err) {
    console.warn("[WebPush] Retry failed:", err);
  }
};

/**
 * Sync app focus state to the Tauri Rust socket backend so background
 * notifications and auto-PONG only fire when the app is unfocused/backgrounded.
 */
export const syncTauriAppFocus = (focused: boolean): void => {
  if (!isTauri()) return;
  invoke("set_app_focused", { focused }).catch(() => {
    // Ignore in environments where the command isn't registered
  });
};

/**
 * Sync notification preferences to the Tauri Rust socket backend.
 */
export const syncTauriNotificationSettings = (
  enabled: boolean,
  customMentions: string[],
): void => {
  if (!isTauri()) return;
  invoke("sync_notification_settings", {
    enabled,
    customMentions,
  }).catch(() => {
    // Ignore in environments where the command isn't registered
  });
};

/**
 * Subscribe or unsubscribe browser Web Push for a server advertising a VAPID key (soju.im/webpush).
 */
export const syncServerWebPush = async (
  serverId: string,
  vapidKey: string,
  enabled: boolean,
  sendRaw: (serverId: string, line: string) => void,
): Promise<void> => {
  if (vapidKey) {
    serverVapidKeys.set(serverId, vapidKey);
  }
  if (isTauri()) return;
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (!("PushManager" in window)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    if (!enabled) {
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        sendRaw(serverId, `WEBPUSH UNREGISTER ${existing.endpoint}`);
        if (typeof existing.unsubscribe === "function") {
          try {
            await existing.unsubscribe();
          } catch {
            // Ignore
          }
        }
      }
      retriedWebPushServers.delete(serverId);
      return;
    }

    const permission = await requestNotificationPermission();
    if (permission !== "granted") return;

    const subscription = await getOrCreatePushSubscription(
      registration,
      vapidKey,
      false,
      (staleEndpoint) => {
        sendRaw(serverId, `WEBPUSH UNREGISTER ${staleEndpoint}`);
      },
    );
    if (!subscription) return;

    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (subscription.endpoint && p256dh && auth) {
      sendRaw(
        serverId,
        `WEBPUSH REGISTER ${subscription.endpoint} p256dh=${p256dh};auth=${auth}`,
      );
    }
  } catch (error) {
    console.warn("[WebPush] Failed to sync subscription:", error);
  }
};

/**
 * Re-sync WebPush across all servers that advertised a VAPID key.
 */
export const syncAllServersWebPush = (
  enabled: boolean,
  sendRaw: (serverId: string, line: string) => void,
): void => {
  if (!enabled) {
    if (
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window
    ) {
      void navigator.serviceWorker.ready.then(async (registration) => {
        try {
          const existing = await registration.pushManager.getSubscription();
          if (existing) {
            for (const serverId of serverVapidKeys.keys()) {
              sendRaw(serverId, `WEBPUSH UNREGISTER ${existing.endpoint}`);
            }
            if (typeof existing.unsubscribe === "function") {
              await existing.unsubscribe();
            }
          }
        } catch {
          // Ignore
        }
      });
    }
    retriedWebPushServers.clear();
    return;
  }

  for (const [serverId, vapidKey] of serverVapidKeys.entries()) {
    void syncServerWebPush(serverId, vapidKey, enabled, sendRaw);
  }
};

/**
 * Check if the browser or Tauri Notification API is supported
 */
export const isNotificationSupported = (): boolean => {
  if (isTauri()) return true;
  return typeof window !== "undefined" && "Notification" in window;
};

/**
 * Request notification permission from the browser or Tauri OS
 */
export const requestNotificationPermission =
  async (): Promise<NotificationPermission> => {
    if (isTauri()) {
      try {
        const granted = await tauriIsPermissionGranted();
        if (granted) return "granted";
        return await tauriRequestPermission();
      } catch (error) {
        console.error("Error requesting Tauri notification permission:", error);
        return "denied";
      }
    }

    if (!isNotificationSupported()) {
      return "denied";
    }

    if (Notification.permission !== "default") {
      return Notification.permission;
    }

    try {
      return await Notification.requestPermission();
    } catch (error) {
      console.error("Error requesting notification permission:", error);
      return "denied";
    }
  };

/**
 * Show a browser notification
 */
export const showBrowserNotification = (
  title: string,
  options?: NotificationOptions,
): Notification | null => {
  if (!isNotificationSupported() || isTauri()) {
    return null;
  }

  if (Notification.permission !== "granted") {
    return null;
  }

  try {
    return new Notification(title, options);
  } catch (error) {
    // Mobile browsers require ServiceWorkerRegistration.showNotification()
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.showNotification(title, options))
        .catch((swErr) =>
          console.error("Error showing SW notification:", swErr),
        );
    } else {
      console.error("Error showing notification:", error);
    }
    return null;
  }
};

function getCandidateSelfMentions(currentUser: User): string[] {
  const candidates = new Set<string>();
  if (currentUser.username) {
    candidates.add(currentUser.username);
    const baseNick = currentUser.username.replace(/_+$/, "");
    if (baseNick) {
      candidates.add(baseNick);
    }
  }
  if (currentUser.account && currentUser.account !== "*") {
    candidates.add(currentUser.account);
  }
  return Array.from(candidates);
}

/**
 * Check if a message contains a mention for the current user
 */
export const checkForMention = (
  messageContent: string,
  currentUser: User | null,
  globalSettings: GlobalSettings,
): boolean => {
  if (!currentUser) return false;

  const selfCandidates = getCandidateSelfMentions(currentUser);
  return (
    selfCandidates.some((candidate) =>
      containsWholeWord(messageContent, candidate),
    ) ||
    globalSettings.customMentions.some((mention: string) =>
      containsWholeWord(messageContent, mention),
    )
  );
};

/**
 * Extract mentioned users from a message
 */
export const extractMentions = (
  messageContent: string,
  currentUser: User | null,
  globalSettings: GlobalSettings,
): string[] => {
  const mentions: string[] = [];

  if (!currentUser) return mentions;

  for (const candidate of getCandidateSelfMentions(currentUser)) {
    if (
      containsWholeWord(messageContent, candidate) &&
      !mentions.includes(candidate)
    ) {
      mentions.push(candidate);
    }
  }

  for (const mention of globalSettings.customMentions) {
    if (
      containsWholeWord(messageContent, mention) &&
      !mentions.includes(mention)
    ) {
      mentions.push(mention);
    }
  }

  return mentions;
};

/**
 * Show a mention notification using Tauri API, Service Worker, browser API, or fallback
 */
export const showMentionNotification = async (
  serverId: string,
  channelName: string,
  sender: string,
  message: string,
  onFallback?: (serverId: string, message: string) => void,
  msgid?: string,
): Promise<void> => {
  const title = channelName.startsWith("DM from ")
    ? channelName
    : `${sender} mentioned you in ${channelName}`;
  const body =
    message.length > 100 ? `${message.substring(0, 100)}...` : message;

  if (isTauri()) {
    // When the app is hidden/backgrounded, the Rust socket reader in
    // src-tauri/src/socket.rs already fires the native notification directly.
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    try {
      await invoke("send_native_notification", { title, body });
      return;
    } catch {
      // Fall back to plugin-notification if command is unavailable
    }
    try {
      const granted = await tauriIsPermissionGranted();
      if (granted) {
        tauriSendNotification({ title, body });
        return;
      }
    } catch (error) {
      console.error("Error sending Tauri notification:", error);
    }
  } else if (
    isNotificationSupported() &&
    Notification.permission === "granted"
  ) {
    const tag = msgid
      ? `obby-msg-${msgid}`
      : `mention-${serverId}-${channelName}-${Date.now()}`;
    const options: NotificationOptions = {
      body,
      icon: "/images/obby.png",
      tag,
      requireInteraction: false,
    };

    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.showNotification(title, options);
          return;
        }
      } catch {
        // Fall through to new Notification
      }
    }

    const notification = showBrowserNotification(title, options);
    if (notification) {
      return;
    }
  }

  // Fallback to in-app notification
  if (onFallback) {
    onFallback(
      serverId,
      `You were mentioned by ${sender} in ${channelName}: ${message}`,
    );
  }
};
