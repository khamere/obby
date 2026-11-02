import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingDefinition } from "../../../src/lib/settings/types";

const saveFileToDevice = vi.hoisted(() =>
  vi.fn((_file: File) => Promise.resolve()),
);
vi.mock("../../../src/lib/saveFile", () => ({ saveFileToDevice }));

const backup = vi.hoisted(() => ({
  encryptBackup: vi.fn(),
  decryptBackup: vi.fn(),
  restoreStorage: vi.fn(),
  snapshotStorage: vi.fn(() => ({ savedServers: "[]" })),
}));
vi.mock("../../../src/lib/backup", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...backup,
}));

import { BackupField } from "../../../src/components/ui/settings/BackupField";
import { BackupFailure } from "../../../src/lib/backup";

vi.setConfig({ testTimeout: 15_000 });

// jsdom's File lacks text(), which every browser Obby runs in has.
if (typeof File.prototype.text !== "function")
  File.prototype.text = function text(this: File) {
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this);
    });
  };

const setting = { id: "preferences.backup" } as SettingDefinition;
const renderField = () =>
  render(<BackupField setting={setting} value={null} onChange={vi.fn()} />);
const type = (input: HTMLElement, value: string) =>
  fireEvent.change(input, { target: { value } });
const pick = (file: File) => {
  const picker = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(picker, "files", { value: [file], configurable: true });
  fireEvent.change(picker);
};

describe("BackupField", () => {
  beforeEach(() => {
    saveFileToDevice.mockClear();
    backup.encryptBackup.mockReset().mockResolvedValue("ciphertext");
    backup.decryptBackup.mockReset();
    backup.restoreStorage.mockReset();
  });
  afterEach(cleanup);

  it("downloads only once both passwords match and are long enough", async () => {
    renderField();
    const [pw, repeat] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    );
    const button = screen.getByRole("button", { name: "Download backup" });
    type(pw, "short");
    type(repeat, "short");
    expect(button).toHaveProperty("disabled", true);
    type(pw, "long enough password");
    expect(button).toHaveProperty("disabled", true);
    type(repeat, "long enough password");
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    await screen.findByText(/Backup saved/);
    expect(backup.encryptBackup).toHaveBeenCalledWith(
      { savedServers: "[]" },
      "long enough password",
    );
    const file = saveFileToDevice.mock.calls[0][0];
    expect(file.name).toMatch(/^obby-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("tells a wrong password apart from a file that is not a backup", async () => {
    renderField();
    pick(new File(["{}"], "b.json", { type: "application/json" }));
    type(screen.getByPlaceholderText("Password of that backup"), "pw");

    backup.decryptBackup.mockRejectedValueOnce(
      new BackupFailure("wrong-password"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByText(/Wrong password/);

    backup.decryptBackup.mockRejectedValueOnce(
      new BackupFailure("not-a-backup"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByText(/not an Obby backup/);
    expect(backup.restoreStorage).not.toHaveBeenCalled();
  });

  it("replaces storage only after the user confirms, then reloads", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderField();
    pick(new File(["{}"], "b.json", { type: "application/json" }));
    type(screen.getByPlaceholderText("Password of that backup"), "pw");
    backup.decryptBackup.mockResolvedValueOnce({
      savedAt: "2026-11-03T00:00:00Z",
      entries: { savedServers: "[1]" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByText("Replace everything on this device?");
    expect(backup.restoreStorage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace and reload" }));
    expect(backup.restoreStorage).toHaveBeenCalledWith({ savedServers: "[1]" });
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
