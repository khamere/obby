import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPreview } from "../../src/components/message/MapPreview";

const openMedia = vi.fn();

vi.mock("../../src/store", () => ({
  default: Object.assign(
    vi.fn((selector: (state: unknown) => unknown) =>
      typeof selector === "function" ? selector({ openMedia }) : null,
    ),
    { getState: () => ({ openMedia }) },
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LOCATION_URL =
  "https://www.openstreetmap.org/?mlat=51.5&mlon=-0.12#map=14/51.5/-0.12";

describe("MapPreview", () => {
  it("renders nothing for an openstreetmap.org link with no position", () => {
    const { container } = render(
      <MapPreview url="https://www.openstreetmap.org/about" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders tiles from the trusted tile host for a valid location link", () => {
    render(<MapPreview url={LOCATION_URL} />);
    const images = screen.getAllByRole("presentation", { hidden: true });
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      expect(img.getAttribute("src")).toMatch(
        /^https:\/\/tile\.openstreetmap\.org\//,
      );
    }
  });

  it("renders a link with an oversized zoom at the deepest tile level", () => {
    render(
      <MapPreview url="https://www.openstreetmap.org/?mlat=1&mlon=1#map=60/1/1" />,
    );
    const images = screen.getAllByRole("presentation", { hidden: true });
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBeLessThanOrEqual(6);
    for (const img of images) {
      expect(img.getAttribute("src")).toMatch(
        /^https:\/\/tile\.openstreetmap\.org\/19\//,
      );
    }
  });

  it("reports failure for a position outside the coordinate range", () => {
    const onRenderFailed = vi.fn();
    const url =
      "https://www.openstreetmap.org/?mlat=1e300&mlon=1e300#map=14/1/1";
    const { container } = render(
      <MapPreview url={url} onRenderFailed={onRenderFailed} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(onRenderFailed).toHaveBeenCalledWith(url);
  });

  it("renders only a still image, never an interactive map", () => {
    const { container } = render(<MapPreview url={LOCATION_URL} />);
    expect(container.querySelector(".leaflet-container")).toBeNull();
    expect(container.querySelector('[data-testid="map-viewer"]')).toBeNull();
  });

  it("shows credit to OpenStreetMap contributors", () => {
    render(<MapPreview url={LOCATION_URL} />);
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
  });

  it("opens the media viewer on click instead of navigating directly", () => {
    render(
      <MapPreview
        url={LOCATION_URL}
        msgid="msg1"
        serverId="s1"
        channelId="c1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open map/i }));

    expect(openMedia).toHaveBeenCalledWith(LOCATION_URL, "msg1", "s1", "c1");
  });

  it("reports failure and renders nothing when a location URL doesn't parse", () => {
    const onRenderFailed = vi.fn();
    const url = "https://www.openstreetmap.org/about";
    const { container } = render(
      <MapPreview url={url} onRenderFailed={onRenderFailed} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(onRenderFailed).toHaveBeenCalledWith(url);
  });

  it("reports failure and renders nothing once every tile fails to load", async () => {
    const onRenderFailed = vi.fn();
    const { container } = render(
      <MapPreview url={LOCATION_URL} onRenderFailed={onRenderFailed} />,
    );
    const images = screen.getAllByRole("presentation", { hidden: true });
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      fireEvent.error(img);
    }

    await waitFor(() =>
      expect(onRenderFailed).toHaveBeenCalledWith(LOCATION_URL),
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
