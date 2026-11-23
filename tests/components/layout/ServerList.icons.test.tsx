import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ServerList } from "../../../src/components/layout/ServerList";
import type { MediaVisibilityLevel } from "../../../src/lib/mediaUtils";
import useStore from "../../../src/store";
import type { Server } from "../../../src/types";

// Loading the modules under test takes seconds on a busy machine, longer
// than the default timeout allows.
vi.setConfig({ testTimeout: 15_000 });

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn(() => "linux"),
}));

const FILEHOST = "https://files.example.org";
const OWN_ICON = `${FILEHOST}/icon.png`;
const FOREIGN_ICON = "https://tracker.example.net/icon.png";

const connected = (server: Partial<Server>): Server => ({
  id: "direct",
  name: "Direct",
  host: "irc.example.com",
  port: 443,
  channels: [],
  privateChats: [],
  users: [],
  isConnected: true,
  connectionState: "connected",
  filehost: FILEHOST,
  ...server,
});

const direct = (icon: string) => [connected({ icon })];
const behindBouncer = (icon: string) => [
  connected({ id: "bouncer", name: "Bouncer", isBouncerControl: true }),
  connected({
    id: "network",
    name: "Network",
    bouncerServerId: "bouncer",
    bouncerNetid: "1",
    icon,
  }),
];

function iconsShown(
  servers: Server[],
  mediaVisibilityLevel: MediaVisibilityLevel,
) {
  useStore.setState((state) => ({
    servers,
    bouncers: {},
    globalSettings: { ...state.globalSettings, mediaVisibilityLevel },
  }));
  const { container } = render(
    <ServerList expanded={false} onToggleExpanded={() => {}} />,
  );
  return [...container.querySelectorAll("img")]
    .map((img) => img.getAttribute("src"))
    .filter((src) => src?.startsWith("http"));
}

// The server names its icon, and the address can be any host, which would see who loads it.
describe.each([
  ["a server", direct],
  ["a network behind a bouncer", behindBouncer],
])("the icon of %s", (_, servers) => {
  beforeEach(() => {
    useStore.setState({ servers: [], bouncers: {} });
  });

  test("is not loaded while media is off", () => {
    expect(iconsShown(servers(OWN_ICON), 0)).toEqual([]);
    expect(iconsShown(servers(FOREIGN_ICON), 0)).toEqual([]);
  });

  test("is loaded from the server's file host once safe media is on", () => {
    expect(iconsShown(servers(OWN_ICON), 1)).toEqual([OWN_ICON]);
  });

  test("is not loaded from another host while only safe media is on", () => {
    expect(iconsShown(servers(FOREIGN_ICON), 1)).toEqual([]);
  });

  test("is loaded from any host once all external content is on", () => {
    expect(iconsShown(servers(FOREIGN_ICON), 3)).toEqual([FOREIGN_ICON]);
  });
});
