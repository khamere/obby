import { base64ToBytes, bytesToBase64 } from "./base64";

// A backup holds every key Obby keeps in local storage: saved servers with
// their passwords, upload tokens, encryption identities, settings and
// layout. It is only ever written encrypted under a password the user
// chooses, so the file can sit in a cloud folder or a chat without handing
// those secrets to whoever finds it.
export const BACKUP_FORMAT = "obby-backup";
export const BACKUP_VERSION = 1;
export const PASSWORD_MIN_LENGTH = 8;
const PBKDF2_ITERATIONS = 600_000;

export type BackupError = "not-a-backup" | "wrong-password" | "unsupported";

export class BackupFailure extends Error {
  constructor(readonly code: BackupError) {
    super(code);
  }
}

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
}

interface BackupPayload {
  savedAt: string;
  entries: Record<string, string>;
}

// WebCrypto wants views over a plain ArrayBuffer, which the shared base64
// helper does not promise, so we copy the bytes into one.
function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function snapshotStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = value;
  }
  return entries;
}

export async function encryptBackup(
  entries: Record<string, string>,
  password: string,
  now: Date = new Date(),
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const payload: BackupPayload = { savedAt: now.toISOString(), entries };
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
    data: bytesToBase64(new Uint8Array(data)),
  };
  return JSON.stringify(file);
}

function parseBackupFile(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupFailure("not-a-backup");
  }
  const file = parsed as Partial<BackupFile> | null;
  if (
    !file ||
    typeof file !== "object" ||
    file.format !== BACKUP_FORMAT ||
    typeof file.version !== "number"
  )
    throw new BackupFailure("not-a-backup");
  if (file.version > BACKUP_VERSION) throw new BackupFailure("unsupported");
  if (
    file.kdf?.name !== "PBKDF2" ||
    file.kdf.hash !== "SHA-256" ||
    typeof file.kdf.iterations !== "number" ||
    typeof file.kdf.salt !== "string" ||
    file.cipher?.name !== "AES-GCM" ||
    typeof file.cipher.iv !== "string" ||
    typeof file.data !== "string"
  )
    throw new BackupFailure("not-a-backup");
  return file as BackupFile;
}

export async function decryptBackup(
  text: string,
  password: string,
): Promise<BackupPayload> {
  const file = parseBackupFile(text);
  const key = await deriveKey(
    password,
    toBuffer(base64ToBytes(file.kdf.salt)),
    file.kdf.iterations,
  );
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBuffer(base64ToBytes(file.cipher.iv)) },
      key,
      toBuffer(base64ToBytes(file.data)),
    );
  } catch {
    // AES-GCM refuses both a wrong key and a changed ciphertext the same way.
    throw new BackupFailure("wrong-password");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new BackupFailure("not-a-backup");
  }
  const candidate = payload as Partial<BackupPayload> | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.savedAt !== "string" ||
    !candidate.entries ||
    typeof candidate.entries !== "object" ||
    Object.values(candidate.entries).some((v) => typeof v !== "string")
  )
    throw new BackupFailure("not-a-backup");
  return candidate as BackupPayload;
}

// Everything on the device gives way to the backup, so a key the backup
// lacks goes too and the app comes up exactly as it was saved.
export function restoreStorage(entries: Record<string, string>): void {
  localStorage.clear();
  for (const [key, value] of Object.entries(entries))
    localStorage.setItem(key, value);
}

export function backupFileName(now: Date = new Date()): string {
  return `obby-backup-${now.toISOString().slice(0, 10)}.json`;
}
