import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MediaViewerModal } from "../../src/components/ui/MediaViewerModal";
import { encodeMediaDescriptor } from "../../src/lib/e2ee/media";
import { E2EE_MEDIA_TAG } from "../../src/lib/e2ee/messageFlags";
import * as mediaProbe from "../../src/lib/mediaProbe";

vi.mock("../../src/lib/openUrl", () => ({ openExternalUrl: vi.fn() }));

// Every document fails to load, which is what pdf.js does for a host that
// sends no CORS headers or answers with something other than a PDF.
vi.mock("react-pdf", () => ({
  Document: ({ onLoadError }: { onLoadError?: () => void }) => {
    React.useEffect(() => {
      onLoadError?.();
    }, [onLoadError]);
    return React.createElement("div", { "data-testid": "pdf-document" });
  },
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
}));

vi.mock("../../src/lib/platformUtils", () => ({ isTauri: vi.fn(() => false) }));

const mock = vi.hoisted(() => ({
  globalSettings: {
    mediaVisibilityLevel: 1,
    mediaAllowedHosts: ["img.example"],
  } as { mediaVisibilityLevel: number; mediaAllowedHosts?: string[] },
  messages: [] as unknown[],
}));

vi.mock("../../src/store", () => ({
  getChannelMessages: vi.fn(() => mock.messages),
  default: Object.assign(
    vi.fn((selector: (state: unknown) => unknown) =>
      typeof selector === "function"
        ? selector({ messages: {}, globalSettings: mock.globalSettings })
        : null,
    ),
    {
      getState: vi.fn(() => ({
        messages: {},
        servers: [
          {
            id: "s1",
            filehost: "https://files.example",
            channels: [{ id: "c1", topic: null }],
          },
        ],
      })),
    },
  ),
}));

vi.mock("../../src/lib/mediaProbe", () => ({
  probeMediaUrl: vi.fn((url: string) =>
    Promise.resolve({
      type: url.endsWith(".pdf") ? "pdf" : "image",
      skipped: false,
    }),
  ),
  getCachedProbeResult: vi.fn((_url: string) => undefined),
}));

vi.mock("../../src/lib/ircClient", () => ({
  default: { sendRaw: vi.fn() },
  ircClient: { sendRaw: vi.fn() },
}));

let n = 0;
function message(content: string, tags?: Record<string, string>) {
  n++;
  return {
    id: `v${n}`,
    msgid: `v${n}`,
    content,
    serverId: "s1",
    channelId: "c1",
    type: "message",
    timestamp: new Date(),
    userId: "user1",
    reactions: [],
    tags,
  };
}

const FILEHOST_A = "https://files.example/a.jpg";
const LISTED = "https://img.example/b.jpg";
const FILEHOST_C = "https://files.example/c.jpg";
const UNLISTED = "https://other.example/d.jpg";

const probedHosts = () =>
  vi
    .mocked(mediaProbe.probeMediaUrl)
    .mock.calls.map(([url]) => new URL(url).hostname);

function viewer(url: string) {
  return (
    <MediaViewerModal
      isOpen={true}
      url={url}
      onClose={vi.fn()}
      serverId="s1"
      channelId="c1"
    />
  );
}

beforeEach(() => {
  mock.globalSettings = {
    mediaVisibilityLevel: 1,
    mediaAllowedHosts: ["img.example"],
  };
  mock.messages = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MediaViewerModal — the user's allowed sites", () => {
  test("the gallery holds file-host and listed-site media and probes no other host", async () => {
    mock.messages = [
      message(FILEHOST_A),
      message(LISTED),
      message(FILEHOST_C),
      message(UNLISTED),
    ];
    render(viewer(FILEHOST_A));

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /image \d+ of 3/i }),
      ).toHaveLength(3),
    );
    expect(probedHosts()).toContain("img.example");
    expect(probedHosts()).not.toContain("other.example");
  });

  test("a listed-site entry drops out when the list is emptied", async () => {
    mock.messages = [message(FILEHOST_A), message(LISTED), message(FILEHOST_C)];
    const { rerender } = render(viewer(FILEHOST_A));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /image \d+ of 3/i }),
      ).toHaveLength(3),
    );

    vi.mocked(mediaProbe.probeMediaUrl).mockClear();
    mock.globalSettings = { mediaVisibilityLevel: 1, mediaAllowedHosts: [] };
    rerender(viewer(FILEHOST_A));

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /image \d+ of 2/i }),
      ).toHaveLength(2),
    );
    expect(probedHosts()).not.toContain("img.example");
  });

  test("settings saved before the list existed build the gallery from the file host alone", async () => {
    mock.globalSettings = { mediaVisibilityLevel: 1 };
    mock.messages = [message(FILEHOST_A), message(LISTED), message(FILEHOST_C)];
    render(viewer(FILEHOST_A));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /image \d+ of 2/i }),
      ).toHaveLength(2),
    );
    expect(probedHosts()).not.toContain("img.example");
  });

  test("an encrypted attachment on a listed site stays out of the gallery", async () => {
    const tag = encodeMediaDescriptor({
      url: "https://img.example/ab12.obb",
      k: "aaaa",
      n: "bbbb",
      mime: "image/png",
      name: "secret.png",
      size: 4242,
    });
    mock.messages = [
      message(FILEHOST_A),
      message(LISTED),
      message("", { [E2EE_MEDIA_TAG]: tag }),
    ];
    render(viewer(FILEHOST_A));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /image \d+ of 2/i }),
      ).toHaveLength(2),
    );
    expect(screen.queryByRole("button", { name: /of 3/i })).toBeNull();
  });
});

describe("MediaViewerModal — PDF that pdf.js cannot load", () => {
  test("from a listed site shows the notice and never the native viewer", async () => {
    const url = "https://img.example/doc.pdf";
    mock.messages = [message(url)];
    render(viewer(url));

    await waitFor(() =>
      expect(
        screen.getByText("PDF cannot be displayed in browser."),
      ).toBeTruthy(),
    );
    expect(document.querySelector("object")).toBeNull();
    expect(screen.getAllByText("Open in browser").length).toBeGreaterThan(0);
  });

  test("from the server's file host still falls back to the native viewer", async () => {
    const url = "https://files.example/doc.pdf";
    mock.messages = [message(url)];
    render(viewer(url));

    await waitFor(() =>
      expect(document.querySelector("object")?.getAttribute("data")).toBe(url),
    );
  });
});
