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
      "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
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
      "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
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
      expect(isSelfNick("mrkmrtns", "mrkmrtns")).toBe(true);
      expect(isSelfNick("MrkMrtns", "mrkmrtns")).toBe(true);
      expect(isSelfNick("mrkmrtns", "MRKMRTNS")).toBe(true);
    });

    it("recognizes alternate nicks with trailing underscores", () => {
      expect(isSelfNick("mrkmrtns_", "mrkmrtns")).toBe(true);
      expect(isSelfNick("mrkmrtns__", "mrkmrtns")).toBe(true);
      expect(isSelfNick("mrkmrtns", "mrkmrtns_")).toBe(true);
    });

    it("recognizes bouncer multiplexed /network and @host nicks", () => {
      expect(isSelfNick("mrkmrtns", "mrkmrtns/libera")).toBe(true);
      expect(isSelfNick("mrkmrtns/libera", "mrkmrtns")).toBe(true);
      expect(isSelfNick("mrkmrtns/libera", undefined, ["mrkmrtns"])).toBe(true);
      expect(isSelfNick("mrkmrtns@bouncer", "mrkmrtns")).toBe(true);
    });

    it("recognizes nicks with square brackets, angle brackets, and prefixes", () => {
      expect(isSelfNick("[mrkmrtns]", "mrkmrtns")).toBe(true);
      expect(isSelfNick("mrkmrtns", "[mrkmrtns]")).toBe(true);
      expect(isSelfNick("<mrkmrtns>", "mrkmrtns")).toBe(true);
      expect(isSelfNick("(mrkmrtns)", "mrkmrtns")).toBe(true);
      expect(isSelfNick("~mrkmrtns", "mrkmrtns")).toBe(true);
      expect(isSelfNick("mrkmrtns[m]", "mrkmrtns")).toBe(true);
      expect(isSelfNick("mrkmrtns|away", "mrkmrtns")).toBe(true);
    });

    it("matches candidates from allOwnNicks list", () => {
      expect(isSelfNick("alice", "bob", ["charlie", "alice"])).toBe(true);
      expect(isSelfNick("alice_", "bob", ["alice"])).toBe(true);
      expect(isSelfNick("[alice]", "bob", ["alice"])).toBe(true);
    });

    it("returns false for different users", () => {
      expect(isSelfNick("bob", "mrkmrtns", ["mrkmrtns"])).toBe(false);
      expect(isSelfNick("mrkmrtns_imposter", "mrkmrtns", ["mrkmrtns"])).toBe(
        false,
      );
      expect(isSelfNick("", "mrkmrtns")).toBe(false);
    });
  });

  describe("normalizeNick", () => {
    it("strips brackets, prefixes, network multiplexers, and trailing underscores", () => {
      expect(normalizeNick("[mrkmrtns]")).toBe("mrkmrtns");
      expect(normalizeNick("<mrkmrtns>")).toBe("mrkmrtns");
      expect(normalizeNick("~mrkmrtns")).toBe("mrkmrtns");
      expect(normalizeNick("mrkmrtns[m]")).toBe("mrkmrtns");
      expect(normalizeNick("mrkmrtns|web")).toBe("mrkmrtns");
      expect(normalizeNick("mrkmrtns_")).toBe("mrkmrtns");
      expect(normalizeNick("mrkmrtns/libera")).toBe("mrkmrtns");
    });
  });

  describe("isRelayedSelfMessage", () => {
    const user = { username: "mrkmrtns" } as unknown as User;

    it("identifies bridge-relayed messages where the author is the user", () => {
      expect(isRelayedSelfMessage("[mrkmrtns] You will!", user)).toBe(true);
      expect(isRelayedSelfMessage("<mrkmrtns> You will!", user)).toBe(true);
      expect(isRelayedSelfMessage("(mrkmrtns) You will!", user)).toBe(true);
      expect(isRelayedSelfMessage("[mrkmrtns (Discord)] You will!", user)).toBe(
        true,
      );
      expect(isRelayedSelfMessage("[mrkmrtns/matrix] You will!", user)).toBe(
        true,
      );
    });

    it("returns false for messages from other users or plain text", () => {
      expect(isRelayedSelfMessage("[alice] You will!", user)).toBe(false);
      expect(isRelayedSelfMessage("You will!", user)).toBe(false);
      expect(isRelayedSelfMessage("mrkmrtns: You will!", user)).toBe(false);
    });
  });

  describe("checkForMention with relayed messages", () => {
    const user = { username: "mrkmrtns" } as unknown as User;
    const settings = { customMentions: [] } as unknown as GlobalSettings;

    it("suppresses mention notifications for relayed self-messages", () => {
      expect(checkForMention("[mrkmrtns] You will!", user, settings)).toBe(
        false,
      );
      expect(checkForMention("<mrkmrtns> You will!", user, settings)).toBe(
        false,
      );
    });

    it("still detects real incoming mentions from other users", () => {
      expect(checkForMention("hey mrkmrtns, You will!", user, settings)).toBe(
        true,
      );
      expect(
        checkForMention("[alice] mrkmrtns: You will!", user, settings),
      ).toBe(true);
    });
  });
});
