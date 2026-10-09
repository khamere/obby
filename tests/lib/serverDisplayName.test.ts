import { describe, expect, test } from "vitest";
import { serverDisplayName } from "../../src/lib/serverDisplayName";
import type { Server } from "../../src/types";

const server: Server = {
  id: "child",
  name: "upload.cx",
  networkName: "Nether.RIP",
  host: "soju.example",
  port: 443,
  channels: [],
  privateChats: [],
  users: [],
  isConnected: true,
  bouncerServerId: "parent",
  bouncerNetid: "1",
};

describe("serverDisplayName", () => {
  test("prefers the saved soju name before the network snapshot arrives", () => {
    expect(serverDisplayName(server)).toBe("upload.cx");
  });
  test("prefers the live soju name over stale saved and upstream names", () => {
    expect(
      serverDisplayName(server, {
        netid: "1",
        attributes: { name: "My Tracker" },
      }),
    ).toBe("My Tracker");
  });
  test.each<Record<string, string>>([
    {},
    { name: "" },
  ])("a known nameless network falls back to NETWORK, then its saved name", (attributes) => {
    const network = { netid: "1", attributes };
    expect(serverDisplayName(server, network)).toBe("Nether.RIP");
    expect(
      serverDisplayName({ ...server, networkName: undefined }, network),
    ).toBe("upload.cx");
  });
  test("an unnamed child falls back to NETWORK", () => {
    expect(serverDisplayName({ ...server, name: "" })).toBe("Nether.RIP");
    expect(
      serverDisplayName({ ...server, name: "", networkName: undefined }),
    ).toBe("");
  });
  test("direct servers and control connections retain upstream-first naming", () => {
    const direct = { ...server, bouncerNetid: undefined };
    expect(serverDisplayName(direct)).toBe("Nether.RIP");
    expect(serverDisplayName({ ...direct, networkName: undefined })).toBe(
      "upload.cx",
    );
    expect(serverDisplayName({ ...direct, isBouncerControl: true })).toBe(
      "Nether.RIP",
    );
  });
});
