import { isRecord } from "../../shared/records.js";

const format = "panda-encryption-key/v1";
const iterations = 600_000;
export const keyBackupExtension = ".pfkey";
export const keyBackupMaxBytes = 16 * 1024;
const algorithm = { name: "RSA-OAEP", hash: "SHA-256" };
export const keySettingsPath = "/settings/encryption-keys";

export interface KeyBackup {
  format: typeof format;
  name: string;
  fingerprint: string;
  publicKey: string;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export function base64Url(input: Uint8Array): string {
  return btoa(String.fromCharCode(...input))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(input: string) {
  return Uint8Array.from(atob(input.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
}

export function hex(input: Uint8Array) {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storeName() {
  const identity = (globalThis as { __pandaForceIdentityKey?: string }).__pandaForceIdentityKey;
  if (!identity) throw new Error("Encryption keys require an account");
  return "pf-encryption-keys:" + identity;
}

function parseBackup(input: unknown): KeyBackup {
  const base64 = (value: unknown, min: number, max: number) =>
    typeof value === "string" && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/u.test(value);
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 7 ||
    input.format !== format ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 80 ||
    typeof input.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.fingerprint) ||
    !base64(input.publicKey, 400, 640) ||
    !base64(input.salt, 22, 22) ||
    !base64(input.nonce, 16, 16) ||
    !base64(input.ciphertext, 1, 6400)
  )
    throw new Error("Invalid encryption key backup");
  return input as unknown as KeyBackup;
}

export function listEncryptionKeys() {
  const raw = localStorage.getItem(storeName());
  if (!raw) return [];
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 50) throw new Error("Invalid encryption key store");
  return entries.map(parseBackup);
}

export function saveEncryptionKey(key: KeyBackup) {
  const entries = listEncryptionKeys();
  if (entries.some((entry) => entry.fingerprint === key.fingerprint)) return;
  if (entries.length >= 50) throw new Error("Encryption key store is full");
  localStorage.setItem(storeName(), JSON.stringify([...entries, key]));
}

function authenticatedMetadata(key: Pick<KeyBackup, "name" | "fingerprint" | "publicKey">) {
  return new TextEncoder().encode(JSON.stringify([format, key.name, key.fingerprint, key.publicKey]));
}

async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, hash: "SHA-256", iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createEncryptionKey(name: string, password: string): Promise<KeyBackup> {
  if (!name.trim() || name.length > 80 || password.length < 12 || password.length > 1024)
    throw new Error("Invalid encryption key settings");
  const pair = await crypto.subtle.generateKey(
    { ...algorithm, modulusLength: 3072, publicExponent: Uint8Array.of(1, 0, 1) },
    true,
    ["encrypt", "decrypt"],
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const metadata = {
    name: name.trim(),
    fingerprint: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey))),
    publicKey: base64Url(publicKey),
  };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  try {
    const key = await passwordKey(password, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: authenticatedMetadata(metadata) },
      key,
      secret,
    );
    return {
      format,
      ...metadata,
      salt: base64Url(salt),
      nonce: base64Url(iv),
      ciphertext: base64Url(new Uint8Array(encrypted)),
    };
  } finally {
    secret.fill(0);
  }
}

export async function unlockEncryptionKey(backup: KeyBackup, password: string) {
  const key = await passwordKey(password, decodeBase64Url(backup.salt));
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64Url(backup.nonce), additionalData: authenticatedMetadata(backup) },
      key,
      decodeBase64Url(backup.ciphertext),
    ),
  );
  try {
    return await crypto.subtle.importKey("pkcs8", decrypted, algorithm, false, ["decrypt"]);
  } finally {
    decrypted.fill(0);
  }
}

export async function restoreEncryptionKey(input: unknown, password: string) {
  const backup = parseBackup(input);
  const publicKey = decodeBase64Url(backup.publicKey);
  if (hex(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey))) !== backup.fingerprint)
    throw new Error("Wrong encryption key fingerprint");
  const privateKey = await unlockEncryptionKey(backup, password);
  const recipient = await crypto.subtle.importKey("spki", publicKey, algorithm, false, ["encrypt"]);
  const { modulusLength, publicExponent } = recipient.algorithm as RsaHashedKeyAlgorithm;
  if (modulusLength !== 3072 || hex(publicExponent) !== "010001") throw new Error("Unsupported RSA key");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await crypto.subtle.encrypt("RSA-OAEP", recipient, challenge);
  if (hex(new Uint8Array(await crypto.subtle.decrypt("RSA-OAEP", privateKey, wrapped))) !== hex(challenge))
    throw new Error("Encryption key pair does not match");
  return backup;
}

export function downloadKeyBackup(key: KeyBackup) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(key)], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "panda-key-" + key.fingerprint.slice(0, 12) + keyBackupExtension;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
