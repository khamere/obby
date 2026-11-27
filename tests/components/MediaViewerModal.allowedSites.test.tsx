import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
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
  topic: null as string | null,
  commentImage: "",
}));

const DECRYPTED_BLOB = "blob:http://localhost/decrypted";

vi.mock("../../src/lib/e2ee/decryptedMediaCache", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/lib/e2ee/decryptedMediaCache")
  >()),
  getDecryptedObjectUrl: vi.fn(() => Promise.resolve(DECRYPTED_BLOB)),
}));

// The sidebar reports a click on a comment's image; one button stands in for it.
vi.mock("../../src/components/ui/MediaCommentsSidebar", () => ({
  MediaCommentsSidebar: ({
    onImageClick,
  }: {
    onImageClick: (url: string) => void;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick: () => onImageClick(mock.commentImage) },
      "comment image",
    ),
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
            channels: [{ id: "c1", topic: mock.topic }],
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
  mock.topic = null;
  mock.commentImage = "";
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

  test("the open listed-site image is neither probed nor shown once its site is removed", async () => {
    mock.messages = [message(FILEHOST_A), message(LISTED), message(FILEHOST_C)];
    const { rerender } = render(viewer(LISTED));
    await waitFor(() =>
      expect(screen.getByAltText("Image preview").getAttribute("src")).toBe(
        LISTED,
      ),
    );

    vi.mocked(mediaProbe.probeMediaUrl).mockClear();
    mock.globalSettings = { mediaVisibilityLevel: 1, mediaAllowedHosts: [] };
    rerender(viewer(LISTED));

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /image \d+ of 2/i }),
      ).toHaveLength(2),
    );
    expect(probedHosts()).not.toContain("img.example");
    expect(screen.queryByAltText("Image preview")).toBeNull();
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

  test("a link the server's rules refuse is neither probed nor shown when the viewer opens on it", async () => {
    mock.messages = [message(FILEHOST_A), message(UNLISTED)];
    render(viewer(UNLISTED));

    await waitFor(() =>
      expect(vi.mocked(mediaProbe.probeMediaUrl)).toHaveBeenCalledWith(
        FILEHOST_A,
      ),
    );
    expect(probedHosts()).not.toContain("other.example");
    expect(screen.queryByAltText("Image preview")).toBeNull();
    expect(document.querySelector(`img[src="${UNLISTED}"]`)).toBeNull();
  });

  test("a refused link opened without a channel is neither probed nor shown", async () => {
    render(
      <MediaViewerModal
        isOpen={true}
        url={UNLISTED}
        onClose={vi.fn()}
        serverId="s1"
      />,
    );
    await Promise.resolve();

    expect(probedHosts()).not.toContain("other.example");
    expect(document.querySelector(`img[src="${UNLISTED}"]`)).toBeNull();
  });

  test("an encrypted attachment stays on screen once its link is swapped for the decrypted blob", async () => {
    const url = "https://files.example/ab12.obb";
    const tag = encodeMediaDescriptor({
      url,
      k: "aaaa",
      n: "bbbb",
      mime: "image/png",
      name: "secret.png",
      size: 4242,
    });
    mock.messages = [
      message(FILEHOST_A),
      message("", { [E2EE_MEDIA_TAG]: tag }),
    ];
    render(viewer(url));

    await waitFor(() =>
      expect(screen.getByAltText("Image preview").getAttribute("src")).toBe(
        DECRYPTED_BLOB,
      ),
    );
  });

  test("the gallery takes a topic image from a listed site and none from any other host", async () => {
    const listedTopic = "https://img.example/topic.jpg";
    const unlistedTopic = "https://other.example/topic.jpg";
    mock.topic = `rules ${listedTopic} ${unlistedTopic}`;
    mock.messages = [message(FILEHOST_A)];
    vi.mocked(mediaProbe.getCachedProbeResult).mockImplementation(() => ({
      type: "image",
      streamable: false,
      skipped: false,
    }));
    onTestFinished(() => {
      vi.mocked(mediaProbe.getCachedProbeResult).mockImplementation(
        () => undefined,
      );
    });
    render(viewer(FILEHOST_A));

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /image \d+ of 2/i }),
      ).toHaveLength(2),
    );
    expect(document.querySelector(`img[src="${listedTopic}"]`)).not.toBeNull();
    expect(document.querySelector(`img[src="${unlistedTopic}"]`)).toBeNull();
  });

  describe("a click on a comment's image", () => {
    // Built-in image hosts carry their type in the link, which is what the
    // jump needs; only the first one is on the user's list.
    const LISTED_COMMENT = "https://i.imgur.com/comment.png";
    const UNLISTED_COMMENT = "https://media.giphy.com/media/comment/giphy.gif";

    async function openComments() {
      mock.globalSettings = {
        mediaVisibilityLevel: 1,
        mediaAllowedHosts: ["img.example", "i.imgur.com"],
      };
      mock.messages = [message(FILEHOST_A)];
      render(viewer(FILEHOST_A));
      await waitFor(() =>
        expect(screen.getByAltText("Image preview").getAttribute("src")).toBe(
          FILEHOST_A,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Show comments" }));
      // The comments arrive after the viewer built its gallery.
      mock.messages = [
        ...mock.messages,
        message(LISTED_COMMENT),
        message(UNLISTED_COMMENT),
      ];
    }

    test("jumps to an image on a listed site", async () => {
      await openComments();
      mock.commentImage = LISTED_COMMENT;
      fireEvent.click(screen.getByRole("button", { name: "comment image" }));

      await waitFor(() =>
        expect(screen.getByAltText("Image preview").getAttribute("src")).toBe(
          LISTED_COMMENT,
        ),
      );
    });

    test("stays put for an image on any other host", async () => {
      await openComments();
      mock.commentImage = UNLISTED_COMMENT;
      fireEvent.click(screen.getByRole("button", { name: "comment image" }));

      await Promise.resolve();
      expect(screen.getByAltText("Image preview").getAttribute("src")).toBe(
        FILEHOST_A,
      );
      expect(
        document.querySelector(`img[src="${UNLISTED_COMMENT}"]`),
      ).toBeNull();
    });
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

  test("from a listed site never reaches the native viewer when its site is removed", async () => {
    const url = "https://img.example/doc.pdf";
    mock.messages = [message(url)];
    const { rerender } = render(viewer(url));
    await waitFor(() =>
      expect(
        screen.getByText("PDF cannot be displayed in browser."),
      ).toBeTruthy(),
    );

    vi.mocked(mediaProbe.probeMediaUrl).mockClear();
    mock.globalSettings = { mediaVisibilityLevel: 1, mediaAllowedHosts: [] };
    rerender(viewer(url));

    await waitFor(() =>
      expect(
        screen.queryByText("PDF cannot be displayed in browser."),
      ).toBeNull(),
    );
    expect(document.querySelector("object")).toBeNull();
    expect(probedHosts()).not.toContain("img.example");
  });

  test("from the server's file host still falls back to the native viewer", async () => {
    const url = "https://files.example/doc.pdf";
    mock.messages = [message(url)];
    render(viewer(url));

    await waitFor(() =>
      expect(document.querySelector("object")?.getAttribute("data")).toBe(url),
    );
  });

  test("from a host no rule admits shows the notice and never the native viewer", async () => {
    render(
      <MediaViewerModal
        isOpen={true}
        url="https://other.example/doc.pdf"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("PDF cannot be displayed in browser."),
      ).toBeTruthy(),
    );
    expect(document.querySelector("object")).toBeNull();
  });

  test("decrypted in this tab still falls back to the native viewer", async () => {
    render(
      <MediaViewerModal
        isOpen={true}
        url={DECRYPTED_BLOB}
        onClose={vi.fn()}
        decryptedType="pdf"
      />,
    );

    await waitFor(() =>
      expect(document.querySelector("object")?.getAttribute("data")).toBe(
        DECRYPTED_BLOB,
      ),
    );
  });
});
