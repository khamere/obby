import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadToUserFilehost } from "../../src/lib/userFilehost";

// A stand-in Zipline: answers the CORS preflight the browser sends for the
// authorization header, records the request and replies in the v4 shape.
let server: Server;
let base: string;
let lastRequest: { auth?: string; body: string; path?: string } | null = null;
let replyWith: () => { status: number; body: string } = () => ({
  status: 200,
  body: JSON.stringify({ files: [{ url: "https://img.example/u/abc.png" }] }),
});

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastRequest = {
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("latin1"),
        path: req.url,
      };
      const r = replyWith();
      res
        .writeHead(r.status, { "Content-Type": "application/json" })
        .end(r.body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("uploadToUserFilehost", () => {
  it("posts the file with the raw token and returns the Zipline URL", async () => {
    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const url = await uploadToUserFilehost(file, {
      host: { url: base, token: "secret-token" },
    });
    expect(url).toBe("https://img.example/u/abc.png");
    expect(lastRequest?.path).toBe("/api/upload");
    expect(lastRequest?.auth).toBe("secret-token");
    expect(lastRequest?.body).toContain('name="file"; filename="shot.png"');
    expect(lastRequest?.body).toContain("png-bytes");
  });

  it("reports a rejected token in plain words", async () => {
    replyWith = () => ({ status: 401, body: '{"error":"Unauthorized"}' });
    const file = new File(["x"], "a.png", { type: "image/png" });
    await expect(
      uploadToUserFilehost(file, { host: { url: base, token: "bad" } }),
    ).rejects.toMatch(/token/);
  });

  it("surfaces other server errors verbatim", async () => {
    replyWith = () => ({ status: 413, body: "file too big" });
    const file = new File(["x"], "a.png", { type: "image/png" });
    await expect(
      uploadToUserFilehost(file, { host: { url: base, token: "t" } }),
    ).rejects.toBe("file too big");
  });
});
