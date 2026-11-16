import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open, mkdir, link, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode } from "../../../shared/errors.js";
import { CredentialError } from "./errors.js";
import type { CredentialKey, CredentialKeyProvider } from "./ports.js";

/** An external file may be a private local file, a Docker secret, or a Kubernetes Secret mount. */
export class FileCredentialKey implements CredentialKeyProvider {
  constructor(private path: string) {}
  async load(): Promise<CredentialKey> {
    const buffer = Buffer.alloc(129);
    try {
      const file = await open(this.path, "r");
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 128) throw new CredentialError("keyUnavailable");
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 128) throw new CredentialError("keyUnavailable");
        const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
        if (!/^[a-f0-9]{64}$/.test(text)) throw new CredentialError("keyUnavailable");
        const bytes = Buffer.from(text, "hex");
        return { id: createHash("sha256").update(bytes).digest("hex").slice(0, 16), bytes };
      } finally {
        await file.close();
      }
    } catch {
      throw new CredentialError("keyUnavailable");
    } finally {
      buffer.fill(0);
    }
  }
}

/** Call only for an empty credential store. Missing keys for existing ciphertext must never be replaced. */
export async function initializeCredentialKey(path: string): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  const key = randomBytes(32);
  let created = false;
  let failed = false;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(key.toString("hex") + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  } catch {
    failed = true;
  } finally {
    key.fill(0);
    if (created) {
      try {
        await unlink(temporary);
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw new CredentialError("keyUnavailable");
}
