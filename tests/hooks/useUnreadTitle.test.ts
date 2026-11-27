import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnreadTitle } from "../../src/hooks/useUnreadTitle";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

const server = (id: string, name: string, chats: object) => ({
  id,
  name,
  host: "irc.example",
  port: 6697,
  ...chats,
});

const mentionsAndPrivate = (channelMentions = 1) =>
  [
    server("s1", "SecretNet", {
      channels: [
        {
          id: "c1",
          name: "#secret",
          unreadCount: 3,
          mentionCount: channelMentions,
          isMentioned: true,
        },
        { id: "c2", name: "#b", unreadCount: 2 },
      ],
      privateChats: [
        {
          id: "p1",
          username: "alice",
          unreadCount: 2,
          mentionCount: 2,
          isMentioned: true,
        },
      ],
    }),
  ] as unknown as Server[];

const plainUnread = [
  server("s1", "SecretNet", {
    channels: [{ id: "c1", name: "#a", unreadCount: 4, mentionCount: 0 }],
    privateChats: [],
  }),
] as unknown as Server[];

const secondServer = server("s2", "OtherNet", {
  channels: [
    {
      id: "c9",
      name: "#z",
      unreadCount: 5,
      mentionCount: 2,
      isMentioned: true,
    },
  ],
  privateChats: [],
}) as unknown as Server;

const badgeMock = () => vi.fn((_count?: number) => Promise.resolve());
const defineBadge = (name: string, value: unknown) =>
  Object.defineProperty(navigator, name, { configurable: true, value });
const removeBadgeApi = () => {
  delete (navigator as { setAppBadge?: unknown }).setAppBadge;
  delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
};
const shownIcon = (link: HTMLLinkElement) =>
  decodeURIComponent(link.getAttribute("href") ?? "");

describe("useUnreadTitle", () => {
  let link: HTMLLinkElement;
  let setAppBadge: ReturnType<typeof badgeMock>;
  let clearAppBadge: ReturnType<typeof badgeMock>;
  let unmount: (() => void) | undefined;

  const mount = (servers: Server[]) => {
    useStore.setState({ servers });
    unmount = renderHook(() => useUnreadTitle()).unmount;
  };

  beforeEach(() => {
    document.title = "Obby";
    link = document.createElement("link");
    link.setAttribute("rel", "icon");
    link.setAttribute("type", "image/x-icon");
    link.setAttribute("href", "/images/obby.png");
    document.head.appendChild(link);
    setAppBadge = badgeMock();
    clearAppBadge = badgeMock();
    defineBadge("setAppBadge", setAppBadge);
    defineBadge("clearAppBadge", clearAppBadge);
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    useStore.setState({ servers: [] });
    link.remove();
    removeBadgeApi();
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  });

  it("shows the mention count in the title, on the icon and as the badge", () => {
    mount(mentionsAndPrivate());

    expect(document.title).toBe("(3) Obby");
    expect(link.getAttribute("type")).toBe("image/svg+xml");
    expect(shownIcon(link)).toContain("rgb(242,63,67)");
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenCalledWith(3);
  });

  it("keeps channel, nick and network names out of the title", () => {
    mount(mentionsAndPrivate());

    expect(document.title).not.toContain("#secret");
    expect(document.title).not.toContain("alice");
    expect(document.title).not.toContain("SecretNet");
  });

  it("shows a dot and no badge for plain unread", () => {
    mount(plainUnread);

    expect(document.title).toBe("• Obby");
    expect(shownIcon(link)).toContain("rgb(88,101,242)");
    expect(clearAppBadge).toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("leaves the icon alone when nothing is unread", () => {
    const setAttribute = vi.spyOn(link, "setAttribute");
    mount([]);

    expect(document.title).toBe("Obby");
    expect(setAttribute).not.toHaveBeenCalled();
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("restores the title, the icon and the badge once everything is read", () => {
    mount(mentionsAndPrivate());
    useStore.setState({ servers: [] });

    expect(document.title).toBe("Obby");
    expect(link.getAttribute("href")).toBe("/images/obby.png");
    expect(link.getAttribute("type")).toBe("image/x-icon");
    expect(clearAppBadge).toHaveBeenCalled();
  });

  it("removes the icon type again when the page set none", () => {
    link.removeAttribute("type");
    mount(mentionsAndPrivate());
    expect(link.getAttribute("type")).toBe("image/svg+xml");
    useStore.setState({ servers: [] });

    expect(link.hasAttribute("type")).toBe(false);
    expect(link.getAttribute("href")).toBe("/images/obby.png");
  });

  it("paints once for the same totals", () => {
    mount(mentionsAndPrivate());
    useStore.setState((state) => ({
      ui: { ...state.ui, isMobileMenuOpen: !state.ui.isMobileMenuOpen },
    }));

    expect(setAppBadge).toHaveBeenCalledTimes(1);
  });

  it("updates the number and keeps the icon when the count changes", () => {
    mount(mentionsAndPrivate());
    const setAttribute = vi.spyOn(link, "setAttribute");
    useStore.setState({ servers: mentionsAndPrivate(2) });

    expect(document.title).toBe("(4) Obby");
    expect(setAppBadge).toHaveBeenLastCalledWith(4);
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("adds up every server", () => {
    mount([...mentionsAndPrivate(), secondServer]);

    expect(document.title).toBe("(5) Obby");
  });

  it("works in a browser without the badging API", () => {
    removeBadgeApi();

    expect(() => mount(mentionsAndPrivate())).not.toThrow();
    expect(document.title).toBe("(3) Obby");
  });

  it("ignores a refused badge", async () => {
    defineBadge(
      "setAppBadge",
      vi.fn(() => Promise.reject(new DOMException("x", "NotAllowedError"))),
    );
    mount(mentionsAndPrivate());
    await Promise.resolve();

    expect(document.title).toBe("(3) Obby");
  });

  it("works in a page without an icon link", () => {
    link.remove();

    expect(() => mount(mentionsAndPrivate())).not.toThrow();
    expect(document.title).toBe("(3) Obby");
  });

  it("stays out of the native apps", () => {
    (window as { __TAURI__?: unknown }).__TAURI__ = {};
    mount(mentionsAndPrivate());

    expect(document.title).toBe("Obby");
    expect(link.getAttribute("href")).toBe("/images/obby.png");
    expect(link.getAttribute("type")).toBe("image/x-icon");
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("restores everything on unmount and stops following the store", () => {
    mount(mentionsAndPrivate());
    unmount?.();
    unmount = undefined;

    expect(document.title).toBe("Obby");
    expect(link.getAttribute("href")).toBe("/images/obby.png");
    expect(link.getAttribute("type")).toBe("image/x-icon");
    expect(clearAppBadge).toHaveBeenCalledTimes(1);

    useStore.setState({ servers: mentionsAndPrivate(2) });
    expect(document.title).toBe("Obby");
    expect(link.getAttribute("href")).toBe("/images/obby.png");
    expect(setAppBadge).toHaveBeenCalledTimes(1);
  });

  it("clears when the page goes away and repaints when it comes back", () => {
    mount(mentionsAndPrivate());
    window.dispatchEvent(new Event("pagehide"));

    expect(document.title).toBe("Obby");
    expect(link.getAttribute("href")).toBe("/images/obby.png");
    expect(link.getAttribute("type")).toBe("image/x-icon");
    expect(clearAppBadge).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("pageshow"));

    expect(document.title).toBe("(3) Obby");
    expect(link.getAttribute("type")).toBe("image/svg+xml");
    expect(shownIcon(link)).toContain("rgb(242,63,67)");
    expect(setAppBadge).toHaveBeenCalledTimes(2);
    expect(setAppBadge).toHaveBeenLastCalledWith(3);
  });

  it("paints nothing on a page show with the counts already shown", () => {
    mount(mentionsAndPrivate());
    window.dispatchEvent(new Event("pageshow"));

    expect(setAppBadge).toHaveBeenCalledTimes(1);
  });
});
