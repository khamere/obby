import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopicModal } from "../../src/components/ui/TopicModal";
import useStore from "../../src/store";
import type { Channel, User } from "../../src/types";

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn().mockResolvedValue("linux"),
}));

const viewer: User = { id: "u1", username: "viewer", isOnline: true };

// A topic as it arrives from the server: mIRC colour 44, then text + URL.
const RAW_TOPIC =
  "\x0344Check the IdleRPG site for info and stats - https://idlerpg.darkpeers.org";

const channel: Channel = {
  id: "c1",
  name: "#idlerpg",
  topic: RAW_TOPIC,
  isPrivate: false,
  serverId: "s1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [viewer], // no op status → read-only path
  metadata: {},
};

describe("TopicModal formatting", () => {
  it("renders mIRC colour codes instead of showing their digits", () => {
    render(
      <TopicModal
        isOpen
        onClose={() => {}}
        channel={channel}
        serverId="s1"
        currentUser={viewer}
      />,
    );

    const section = document.body.querySelector('[aria-label="Channel topic"]');
    expect(section).not.toBeNull();
    // The digits of the colour code must not leak into the visible text.
    expect(section?.textContent).not.toContain("44Check");
    expect(section?.textContent).toContain("Check the IdleRPG site");
    // The colour is applied as an inline style on the text.
    const coloured = Array.from(section?.querySelectorAll("span") ?? []).find(
      (el) => (el as HTMLElement).style.color !== "",
    );
    expect(coloured).toBeDefined();
    // The URL is still a security-wrapped link.
    const link = screen.getByText("https://idlerpg.darkpeers.org");
    expect(link.tagName).toBe("A");
    expect(link.className).toContain("external-link-security");
  });
});

describe("TopicModal with topic formatting disabled", () => {
  it("strips colour codes completely instead of showing their digits", () => {
    useStore.setState((s) => ({
      globalSettings: { ...s.globalSettings, formatTopics: false },
    }));
    render(
      <TopicModal
        isOpen
        onClose={() => {}}
        channel={channel}
        serverId="s1"
        currentUser={viewer}
      />,
    );
    const section = document.body.querySelector('[aria-label="Channel topic"]');
    expect(section?.textContent).toBe(
      "Check the IdleRPG site for info and stats - https://idlerpg.darkpeers.org",
    );
    const coloured = Array.from(section?.querySelectorAll("span") ?? []).find(
      (el) => (el as HTMLElement).style.color !== "",
    );
    expect(coloured).toBeUndefined();
    // Links still work in the plain view.
    const link = screen.getByText("https://idlerpg.darkpeers.org");
    expect(link.tagName).toBe("A");
    useStore.setState((s) => ({
      globalSettings: { ...s.globalSettings, formatTopics: true },
    }));
  });
});

describe("mircToHtml linkify option", () => {
  it("emits no anchors when linkify is false", async () => {
    const { mircToHtml } = await import("../../src/lib/ircUtils");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      mircToHtml(RAW_TOPIC, "k-", { linkify: false }),
    );
    expect(html).not.toContain("<a");
    expect(html).toContain("https://idlerpg.darkpeers.org");
    expect(html).not.toContain("44Check");
  });
});
