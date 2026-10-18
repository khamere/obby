import { t } from "@lingui/core/macro";
import { isTauri } from "./platformUtils";

const FLASH_INTERVAL_MS = 1000;

const pending = new Map<string, number>();
let lastSender = "";
let baseTitle: string | null = null;
let flashTimer: ReturnType<typeof setInterval> | null = null;
let flashShowingAlert = false;

const keyOf = (serverId: string, conversationId: string) =>
  `${serverId}\u0000${conversationId}`;

function isWindowAttentive(): boolean {
  return !document.hidden && document.hasFocus();
}

function totalPending(): number {
  let total = 0;
  for (const count of pending.values()) total += count;
  return total;
}

function stopFlashing(): void {
  if (flashTimer !== null) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  flashShowingAlert = false;
}

function quietTitle(): string {
  return `(${totalPending()}) ${baseTitle ?? "IRC"}`;
}

function alertTitle(): string {
  const sender = lastSender;
  return `(${totalPending()}) ${t`${sender} messaged you`}`;
}

function render(): void {
  if (pending.size === 0) {
    stopFlashing();
    if (baseTitle !== null) {
      document.title = baseTitle;
      baseTitle = null;
    }
    return;
  }

  // A visible window only needs the count; flashing is for drawing the eye back.
  if (isWindowAttentive()) {
    stopFlashing();
    document.title = quietTitle();
    return;
  }

  flashShowingAlert = true;
  document.title = alertTitle();
  if (flashTimer === null) {
    flashTimer = setInterval(() => {
      flashShowingAlert = !flashShowingAlert;
      document.title = flashShowingAlert ? alertTitle() : quietTitle();
    }, FLASH_INTERVAL_MS);
  }
}

/**
 * Record an unseen message so the tab title flashes until the user opens the
 * conversation it arrived in.
 */
export function addTitleAlert(
  serverId: string,
  conversationId: string,
  sender: string,
): void {
  // Native windows don't mirror document.title, and a background timer would cost battery on mobile.
  if (typeof document === "undefined" || isTauri()) return;
  if (pending.size === 0) baseTitle = document.title;
  const key = keyOf(serverId, conversationId);
  pending.set(key, (pending.get(key) ?? 0) + 1);
  lastSender = sender;
  render();
}

/**
 * Re-evaluate the title after a focus or selection change; the conversation
 * on screen counts as seen only while the window is focused and visible.
 */
export function syncTitleAlert(
  visibleServerId: string | null,
  visibleConversationId: string | null,
): void {
  if (typeof document === "undefined" || pending.size === 0) return;
  if (visibleServerId && visibleConversationId && isWindowAttentive()) {
    pending.delete(keyOf(visibleServerId, visibleConversationId));
  }
  render();
}

export function resetTitleAlertsForTests(): void {
  pending.clear();
  lastSender = "";
  stopFlashing();
  baseTitle = null;
}
