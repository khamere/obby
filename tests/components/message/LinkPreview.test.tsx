import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LinkPreview } from "../../../src/components/message/LinkPreview";
import type { MediaVisibilityLevel } from "../../../src/lib/mediaUtils";
import useStore from "../../../src/store";
import type { Server } from "../../../src/types";

const FILEHOST = "https://files.example.org";

const server: Server = {
  id: "server1",
  name: "Test Server",
  host: "irc.example.org",
  port: 6697,
  channels: [],
  privateChats: [],
  isConnected: true,
  users: [],
  filehost: FILEHOST,
};

const LEVELS: MediaVisibilityLevel[] = [0, 1, 2, 3];

function cardImage(
  imageUrl: string,
  level: MediaVisibilityLevel,
): string | null {
  useStore.setState((state) => ({
    servers: [server],
    globalSettings: { ...state.globalSettings, mediaVisibilityLevel: level },
  }));
  const { container } = render(
    <LinkPreview
      title="A page"
      snippet="About the page"
      imageUrl={imageUrl}
      messageContent="look https://site.example.com/page"
      serverId="server1"
    />,
  );
  const src = container.querySelector("img")?.getAttribute("src") ?? null;
  // The text of the card stays whatever happens to the image.
  expect(container.textContent).toContain("A page");
  cleanup();
  return src;
}

afterEach(cleanup);

describe("link preview card image", () => {
  it.each([
    ["a relative path", "/api/logout"],
    ["a path without a leading slash", "images/card.png"],
    ["a protocol-relative address", "//tracker.example.net/pixel.png"],
    ["a backslash form of one", "\\\\tracker.example.net\\pixel.png"],
    ["a data: address", "data:image/png;base64,iVBORw0KGgo="],
    ["a javascript: address", "javascript:alert(1)"],
    ["a blob: address", "blob:https://site.example.com/1234"],
    ["a scheme without an authority", "https:card.png"],
    [
      "a non-breaking space before the scheme",
      "\u00A0https://cdn.example.com/card.png",
    ],
    ["a byte order mark before the scheme", "\uFEFFhttps://../../api/logout"],
  ])("loads nothing for %s at any level", (_name, imageUrl) => {
    for (const level of LEVELS) {
      expect(cardImage(imageUrl, level)).toBeNull();
    }
  });

  it("loads an absolute image from another origin only with all content on", () => {
    const imageUrl = "https://cdn.example.com/card.png";
    expect(cardImage(imageUrl, 0)).toBeNull();
    expect(cardImage(imageUrl, 1)).toBeNull();
    expect(cardImage(imageUrl, 2)).toBeNull();
    expect(cardImage(imageUrl, 3)).toBe(imageUrl);
  });

  it("loads an image from the server's file host from the safe level up", () => {
    const imageUrl = `${FILEHOST}/card.png`;
    expect(cardImage(imageUrl, 0)).toBeNull();
    expect(cardImage(imageUrl, 1)).toBe(imageUrl);
    expect(cardImage(imageUrl, 2)).toBe(imageUrl);
    expect(cardImage(imageUrl, 3)).toBe(imageUrl);
  });

  it("keeps an absolute address a browser reads the same way", () => {
    expect(cardImage("HTTPS://cdn.example.com/card.png", 3)).toBe(
      "HTTPS://cdn.example.com/card.png",
    );
    expect(cardImage("http://cdn.example.com/card.png", 3)).toBe(
      "http://cdn.example.com/card.png",
    );
    expect(cardImage(" \thttps://cdn.example.com/card.png", 3)).toBe(
      " \thttps://cdn.example.com/card.png",
    );
  });
});
