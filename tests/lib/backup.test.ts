import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackupFailure,
  backupFileName,
  decryptBackup,
  encryptBackup,
  restoreStorage,
  snapshotStorage,
} from "../../src/lib/backup";

const entries = {
  savedServers: JSON.stringify([{ host: "irc.example", password: "hunter2" }]),
  globalSettings: JSON.stringify({ theme: "dark" }),
};

// The shared test setup stubs localStorage with bare spies, so the snapshot
// and restore checks get a real key-value store.
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

describe("encrypted backup", () => {
  beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips every entry under the right password", async () => {
    const text = await encryptBackup(entries, "correct horse battery");
    const payload = await decryptBackup(text, "correct horse battery");
    expect(payload.entries).toEqual(entries);
  });

  it("keeps the secrets out of the file", async () => {
    const text = await encryptBackup(entries, "correct horse battery");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("irc.example");
    expect(text).not.toContain("savedServers");
  });

  it("refuses the wrong password", async () => {
    const text = await encryptBackup(entries, "correct horse battery");
    await expect(decryptBackup(text, "wrong")).rejects.toMatchObject({
      code: "wrong-password",
    });
  });

  it("refuses a changed file", async () => {
    const file = JSON.parse(await encryptBackup(entries, "pw-long-enough"));
    const bytes = Buffer.from(file.data, "base64");
    bytes[0] ^= 0xff;
    file.data = bytes.toString("base64");
    await expect(
      decryptBackup(JSON.stringify(file), "pw-long-enough"),
    ).rejects.toMatchObject({ code: "wrong-password" });
  });

  it("refuses files that are not backups", async () => {
    for (const text of ["", "{}", "not json", '{"format":"other"}']) {
      await expect(decryptBackup(text, "pw")).rejects.toBeInstanceOf(
        BackupFailure,
      );
      await expect(decryptBackup(text, "pw")).rejects.toMatchObject({
        code: "not-a-backup",
      });
    }
  });

  it("refuses a newer format", async () => {
    const file = JSON.parse(await encryptBackup(entries, "pw-long-enough"));
    file.version = 99;
    await expect(
      decryptBackup(JSON.stringify(file), "pw-long-enough"),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("snapshots and restores local storage as a whole", () => {
    localStorage.setItem("stale", "x");
    restoreStorage(entries);
    expect(localStorage.getItem("stale")).toBeNull();
    expect(snapshotStorage()).toEqual(entries);
  });

  it("names the file by the day it was made", () => {
    expect(backupFileName(new Date("2026-11-03T10:00:00Z"))).toBe(
      "obby-backup-2026-11-03.json",
    );
  });
});
