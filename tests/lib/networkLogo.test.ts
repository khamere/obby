import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { networkLogo } from "../../src/lib/networkLogo";
import logos from "../../src/lib/networkLogos.json";
import type { Server } from "../../src/types";

const server = {
  name: "My network",
  host: "irc.upload.cx",
  port: 6697,
} as Server;

describe("sidebar network branding", () => {
  test("matches hostnames with schemes, ports and case", () => {
    expect(networkLogo({ ...server, host: "ircs://IRC.UPLOAD.CX:6697" })).toBe(
      "/network-logos/upload-cx.svg",
    );
    expect(networkLogo({ ...server, host: "irc.dkok.to:42069" })).toBe(
      "/network-logos/dkokto.svg",
    );
  });
  test("uses the upstream host for bound Soju networks, not NETWORK or bouncer host", () => {
    const child = {
      ...server,
      host: "irc.dkok.to",
      bouncerNetid: "1",
      networkName: "Nether.RIP",
    };
    expect(
      networkLogo(child, {
        netid: "1",
        attributes: { name: "Custom name", host: "irc.upload.cx" },
      }),
    ).toBe("/network-logos/upload-cx.svg");
    expect(
      networkLogo(child, { netid: "1", attributes: { name: "Custom name" } }),
    ).toBeUndefined();
  });
  test("supports exact saved-name aliases without misbranding shared networks", () => {
    expect(
      networkLogo({ ...server, host: "irc.p2p-network.net", name: "Blutopia" }),
    ).toBe("/network-logos/blutopia.svg");
    expect(
      networkLogo({
        ...server,
        host: "irc.p2p-network.net",
        name: "Other community",
      }),
    ).toBeUndefined();
    expect(
      networkLogo({
        ...server,
        host: "soju.example",
        name: "DKOKTO ERGO",
        bouncerNetid: "1",
      }),
    ).toBe("/network-logos/dkokto.svg");
  });
  test("does not match hostname suffixes or turn arbitrary text into an asset URL", () => {
    for (const host of [
      "irc.upload.cx.evil.example",
      "notirc.upload.cx",
      "irc.",
      "https://example.test/irc.upload.cx",
    ]) {
      expect(networkLogo({ ...server, host })).toBeUndefined();
    }
    expect(networkLogo({ ...server, isBouncerControl: true })).toBeUndefined();
  });
  test("all bundled SVGs parse and contain only local resources", () => {
    expect(logos).toHaveLength(31);
    for (const logo of logos) {
      const svg = readFileSync(`public/network-logos/${logo.file}`, "utf8");
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(doc.querySelector("parsererror"), logo.file).toBeNull();
      expect(doc.querySelector("script, foreignObject"), logo.file).toBeNull();
      for (const node of doc.querySelectorAll("*")) {
        for (const attribute of Array.from(node.attributes)) {
          expect(attribute.name, logo.file).not.toMatch(/^on/i);
          if (["href", "xlink:href", "src"].includes(attribute.name)) {
            expect(attribute.value, logo.file).toMatch(
              /^(#|data:image\/png;base64,)/,
            );
          }
          for (const reference of attribute.value.matchAll(
            /url\(([^)]+)\)/gi,
          )) {
            expect(reference[1], logo.file).toMatch(/^['"]?#/);
          }
        }
      }
    }
  });
});
