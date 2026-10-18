import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn((..._args: unknown[]) => Promise.resolve());
const mockIsPermissionGranted = vi.fn(() => Promise.resolve(true));
const mockRequestPermission = vi.fn(() =>
  Promise.resolve("granted" as NotificationPermission),
);
const mockSendNotification = vi.fn((..._args: unknown[]) => undefined);
const mockIsTauri = vi.fn(() => false);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => mockIsPermissionGranted(),
  requestPermission: () => mockRequestPermission(),
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

vi.mock("../../src/lib/platformUtils", () => ({
  isTauri: () => mockIsTauri(),
  isTauriAndroid: () => false,
  isTauriIOS: () => false,
  isTauriMobile: () => false,
}));

import {
  checkForMention,
  isRelayedSelfMessage,
  isSelfNick,
  normalizeNick,
  requestNotificationPermission,
  showMentionNotification,
  syncServerWebPush,
  syncTauriAppFocus,
  syncTauriNotificationSettings,
} from "../../src/lib/notifications";
import type { GlobalSettings } from "../../src/store";
import type { User } from "../../src/types";

describe("notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(false);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("syncs focus and settings to Tauri Rust backend when running in Tauri", () => {
    mockIsTauri.mockReturnValue(true);
    syncTauriAppFocus(false);
    expect(mockInvoke).toHaveBeenCalledWith("set_app_focused", {
      focused: false,
    });

    syncTauriNotificationSettings(true, ["obby", "pingword"], ["myuser"]);
    expect(mockInvoke).toHaveBeenCalledWith("sync_notification_settings", {
      enabled: true,
      customMentions: ["obby", "pingword"],
      ownNicks: ["myuser"],
    });
  });

  it("uses native Tauri notification command when visible and skips when hidden (handled by Rust)", async () => {
    mockIsTauri.mockReturnValue(true);
    mockIsPermissionGranted.mockResolvedValue(true);

    await showMentionNotification("srv-1", "#general", "alice", "hey bob!");
    expect(mockInvoke).toHaveBeenCalledWith("send_native_notification", {
      title: "alice mentioned you in #general",
      body: "hey bob!",
    });

    mockInvoke.mockClear();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    await showMentionNotification("srv-1", "#general", "alice", "backgrounded");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("requests Tauri permission when not yet granted", async () => {
    mockIsTauri.mockReturnValue(true);
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue("granted");

    const result = await requestNotificationPermission();
    expect(result).toBe("granted");
    expect(mockRequestPermission).toHaveBeenCalled();
  });

  it("registers and unregisters Soju WebPush when VAPID is advertised on web", async () => {
    mockIsTauri.mockReturnValue(false);
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        permission: "granted",
        requestPermission: vi.fn(() => Promise.resolve("granted")),
      },
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: class {},
    });

    const mockSubscription = {
      endpoint: "https://push.example.org/sub/123",
      toJSON: () => ({
        endpoint: "https://push.example.org/sub/123",
        keys: {
          p256dh: "test_p256dh_key",
          auth: "test_auth_secret",
        },
      }),
    };
    const mockSubscribe = vi.fn(() => Promise.resolve(mockSubscription));
    const mockGetSubscription = vi.fn<
      () => Promise<typeof mockSubscription | null>
    >(() => Promise.resolve(null));

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: mockGetSubscription,
            subscribe: mockSubscribe,
          },
        }),
      },
    });

    const sendRaw = vi.fn();
    await syncServerWebPush(
      "srv-soju",
      "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      true,
      sendRaw,
    );

    expect(mockSubscribe).toHaveBeenCalled();
    expect(sendRaw).toHaveBeenCalledWith(
      "srv-soju",
      "WEBPUSH REGISTER https://push.example.org/sub/123 p256dh=test_p256dh_key;auth=test_auth_secret",
    );

    mockGetSubscription.mockResolvedValue(mockSubscription);
    sendRaw.mockClear();
    await syncServerWebPush(
      "srv-soju",
      "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      false,
      sendRaw,
    );

    expect(sendRaw).toHaveBeenCalledWith(
      "srv-soju",
      "WEBPUSH UNREGISTER https://push.example.org/sub/123",
    );
  });

  describe("isSelfNick", () => {
    it("recognizes exact and case-insensitive nickname matches", () => {
      expect(isSelfNick("kestrel", "kestrel")).toBe(true);
      expect(isSelfNick("KeStrel", "kestrel")).toBe(true);
      expect(isSelfNick("kestrel", "KESTREL")).toBe(true);
    });

    it("recognizes alternate nicks with trailing underscores", () => {
      expect(isSelfNick("kestrel_", "kestrel")).toBe(true);
      expect(isSelfNick("kestrel__", "kestrel")).toBe(true);
      expect(isSelfNick("kestrel", "kestrel_")).toBe(true);
    });

    it("recognizes bouncer multiplexed /network and @host nicks", () => {
      expect(isSelfNick("kestrel", "kestrel/libera")).toBe(true);
      expect(isSelfNick("kestrel/libera", "kestrel")).toBe(true);
      expect(isSelfNick("kestrel/libera", undefined, ["kestrel"])).toBe(true);
      expect(isSelfNick("kestrel@bouncer", "kestrel")).toBe(true);
    });

    it("recognizes nicks with square brackets, angle brackets, and prefixes", () => {
      expect(isSelfNick("[kestrel]", "kestrel")).toBe(true);
      expect(isSelfNick("kestrel", "[kestrel]")).toBe(true);
      expect(isSelfNick("<kestrel>", "kestrel")).toBe(true);
      expect(isSelfNick("(kestrel)", "kestrel")).toBe(true);
      expect(isSelfNick("~kestrel", "kestrel")).toBe(true);
      expect(isSelfNick("kestrel[m]", "kestrel")).toBe(true);
      expect(isSelfNick("kestrel|away", "kestrel")).toBe(true);
    });

    it("matches candidates from allOwnNicks list", () => {
      expect(isSelfNick("alice", "bob", ["charlie", "alice"])).toBe(true);
      expect(isSelfNick("alice_", "bob", ["alice"])).toBe(true);
      expect(isSelfNick("[alice]", "bob", ["alice"])).toBe(true);
    });

    it("returns false for different users", () => {
      expect(isSelfNick("bob", "kestrel", ["kestrel"])).toBe(false);
      expect(isSelfNick("kestrel_imposter", "kestrel", ["kestrel"])).toBe(
        false,
      );
      expect(isSelfNick("", "kestrel")).toBe(false);
    });
  });

  describe("normalizeNick", () => {
    it("strips brackets, prefixes, network multiplexers, and trailing underscores", () => {
      expect(normalizeNick("[kestrel]")).toBe("kestrel");
      expect(normalizeNick("<kestrel>")).toBe("kestrel");
      expect(normalizeNick("~kestrel")).toBe("kestrel");
      expect(normalizeNick("kestrel[m]")).toBe("kestrel");
      expect(normalizeNick("kestrel|web")).toBe("kestrel");
      expect(normalizeNick("kestrel_")).toBe("kestrel");
      expect(normalizeNick("kestrel/libera")).toBe("kestrel");
    });
  });

  describe("isRelayedSelfMessage", () => {
    const user = { username: "kestrel" } as unknown as User;

    it("identifies bridge-relayed messages where the author is the user", () => {
      expect(isRelayedSelfMessage("[kestrel] You will!", user)).toBe(true);
      expect(isRelayedSelfMessage("<kestrel> You will!", user)).toBe(true);
      expect(isRelayedSelfMessage("(kestrel) You will!", user)).toBe(true);
      expect(isRelayedSelfMessage("[kestrel (Discord)] You will!", user)).toBe(
        true,
      );
      expect(isRelayedSelfMessage("[kestrel/matrix] You will!", user)).toBe(
        true,
      );
    });

    it("returns false for messages from other users or plain text", () => {
      expect(isRelayedSelfMessage("[alice] You will!", user)).toBe(false);
      expect(isRelayedSelfMessage("You will!", user)).toBe(false);
      expect(isRelayedSelfMessage("kestrel: You will!", user)).toBe(false);
    });
  });

  describe("checkForMention with relayed messages", () => {
    const user = { username: "kestrel" } as unknown as User;
    const settings = { customMentions: [] } as unknown as GlobalSettings;

    it("suppresses mention notifications for relayed self-messages", () => {
      expect(checkForMention("[kestrel] You will!", user, settings)).toBe(
        false,
      );
      expect(checkForMention("<kestrel> You will!", user, settings)).toBe(
        false,
      );
    });

    it("still detects real incoming mentions from other users", () => {
      expect(checkForMention("hey kestrel, You will!", user, settings)).toBe(
        true,
      );
      expect(
        checkForMention("[alice] kestrel: You will!", user, settings),
      ).toBe(true);
    });
  });
});
