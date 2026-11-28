import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicMediaStrip } from "../../src/components/ui/TopicMediaStrip";
import { getCachedProbeResult, probeMediaUrl } from "../../src/lib/mediaProbe";
import type { MediaVisibilityLevel } from "../../src/lib/mediaUtils";
import useStore from "../../src/store";
import type { Channel, Server } from "../../src/types";

vi.mock("../../src/lib/ircClient", () => ({
  default: {
    getCurrentUser: vi.fn(() => null),
    getNick: vi.fn(() => "tester"),
    hasCapability: vi.fn(() => false),
    on: vi.fn(),
    sendRaw: vi.fn(),
  },
}));

// The store registers its allowed-site check on the real module, so only the
// probe itself is replaced: a call to it stands for a request to that host.
vi.mock("../../src/lib/mediaProbe", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/lib/mediaProbe")>();
  return {
    ...real,
    getCachedProbeResult: vi.fn(real.getCachedProbeResult),
    probeMediaUrl: vi.fn(async () => ({
      type: "image",
      streamable: false,
      skipped: false,
    })),
  };
});

const LISTED = "https://img.example/topic-a";
const OTHER = "https://other.example/topic-b";

const channel: Channel = {
  id: "channel1",
  name: "#general",
  topic: `today: ${LISTED} and ${OTHER}`,
  isPrivate: false,
  serverId: "server1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
};

const server: Server = {
  id: "server1",
  name: "Test Server",
  host: "irc.test.com",
  port: 6667,
  channels: [channel],
  privateChats: [],
  isConnected: true,
  users: [],
};

function setMedia(level: MediaVisibilityLevel, hosts: string[]) {
  useStore.setState((state) => ({
    globalSettings: {
      ...state.globalSettings,
      mediaVisibilityLevel: level,
      mediaAllowedHosts: hosts,
    },
  }));
}

const probedUrls = () => vi.mocked(probeMediaUrl).mock.calls.map(([u]) => u);

beforeEach(() => {
  useStore.setState((state) => ({
    servers: [server],
    ui: {
      ...state.ui,
      selectedServerId: "server1",
      perServerSelections: {
        server1: { selectedChannelId: "channel1", selectedPrivateChatId: null },
      },
    },
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TopicMediaStrip — the user's allowed sites", () => {
  it("shows a tile for the listed site only and probes nothing else", async () => {
    setMedia(1, ["img.example"]);
    const { container } = render(<TopicMediaStrip />);

    await waitFor(() =>
      expect(container.querySelector(`img[src="${LISTED}"]`)).toBeTruthy(),
    );
    expect(probedUrls()).toEqual([LISTED]);
    expect(container.querySelector(`img[src="${OTHER}"]`)).toBeNull();
  });

  it("probes and looks up a topic link for the server the channel is on", async () => {
    setMedia(1, ["img.example"]);
    render(<TopicMediaStrip />);

    await waitFor(() =>
      expect(probeMediaUrl).toHaveBeenCalledWith(LISTED, "server1"),
    );
    expect(getCachedProbeResult).toHaveBeenCalledWith(LISTED, "server1");
  });

  it("drops the tile when the site is removed", async () => {
    setMedia(1, ["img.example"]);
    const { container } = render(<TopicMediaStrip />);
    await waitFor(() =>
      expect(container.querySelector(`img[src="${LISTED}"]`)).toBeTruthy(),
    );

    act(() => setMedia(1, []));
    await waitFor(() =>
      expect(container.querySelector(`img[src="${LISTED}"]`)).toBeNull(),
    );
  });

  it("probes nothing while previews are off", async () => {
    setMedia(0, ["img.example"]);
    const { container } = render(<TopicMediaStrip />);
    await act(async () => {});
    expect(probedUrls()).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
  });
});
