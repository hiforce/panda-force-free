import type { MemoryMaterialExportSelection } from "../../shared/project-memory/materials.js";
import type { Translate } from "../../shared/i18n/messages.js";
import {
  memoryPackageChunkBytes,
  memoryPackageExtension,
  memoryPackageMediaType,
  type MemoryPackageUpload,
} from "../../shared/project-memory/archive.js";
import {
  isPmf,
  pmfFingerprintBytes,
  pmfHeaderBytes,
  pmfMagic,
  pmfMinimumBytes,
  pmfWrappedKeyBytes,
} from "../../shared/project-memory/pmf-envelope.js";
import {
  base64Url,
  hex,
  listEncryptionKeys,
  unlockEncryptionKey,
  type KeyBackup,
} from "../encryption-keys/key-store.js";
import { checkAuthentication, request } from "../http-client.js";
import { errorText } from "../i18n.js";

function responseError(value: unknown, t: Translate) {
  return Object.assign(new Error(errorText(value, t, "harness.errorUnavailable")), {
    code: value && typeof value === "object" && "code" in value ? value.code : "unavailable",
  });
}

export async function downloadMemoryPackage(
  path: string,
  recipient: Pick<KeyBackup, "publicKey" | "fingerprint">,
  signal: AbortSignal,
  t: Translate,
  materials?: MemoryMaterialExportSelection[],
) {
  const response = await request(path, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: recipient.publicKey, materials }),
  });
  if (!response.ok) throw responseError(await response.json(), t);
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== memoryPackageMediaType)
    throw new Error(t("projects.memoryPackageDownloadInvalid"));
  const blob = await response.blob();
  const header = new Uint8Array(await blob.slice(0, pmfHeaderBytes).arrayBuffer());
  signal.throwIfAborted();
  const fingerprint = hex(header.subarray(pmfMagic.length, pmfMagic.length + pmfFingerprintBytes));
  if (blob.size < pmfMinimumBytes || !isPmf(header) || fingerprint !== recipient.fingerprint)
    throw new Error(t("projects.memoryPackageDownloadInvalid"));
  const url = URL.createObjectURL(blob);
  const download = document.createElement("a");
  download.href = url;
  download.download =
    /^attachment; filename="(panda-project-memory-[a-f0-9]{8}\.pmf)"$/u.exec(
      response.headers.get("content-disposition") ?? "",
    )?.[1] ?? "panda-project-memory" + memoryPackageExtension;
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readMemoryPackageEnvelope(bytes: Uint8Array<ArrayBuffer>, t: Translate) {
  if (bytes.length !== pmfHeaderBytes || !isPmf(bytes)) throw new Error(t("projects.memoryPackageInvalid"));
  const wrappedOffset = pmfMagic.length + pmfFingerprintBytes;
  const fingerprint = hex(bytes.subarray(pmfMagic.length, wrappedOffset));
  const recipient = listEncryptionKeys().find((key) => key.fingerprint === fingerprint);
  return {
    recipient,
    envelope: base64Url(bytes),
    wrapped: bytes.subarray(wrappedOffset, wrappedOffset + pmfWrappedKeyBytes),
  };
}

export async function readMemoryPackageRecipient(file: File, t: Translate) {
  return readMemoryPackageEnvelope(new Uint8Array(await file.slice(0, pmfHeaderBytes).arrayBuffer()), t);
}

export async function unwrapMemoryPackageKey(
  recipient: KeyBackup,
  wrapped: Uint8Array<ArrayBuffer>,
  password: string,
  t: Translate,
) {
  try {
    const privateKey = await unlockEncryptionKey(recipient, password);
    const key = new Uint8Array(await crypto.subtle.decrypt("RSA-OAEP", privateKey, wrapped));
    try {
      if (key.length !== 32) throw new Error("Invalid content key");
      return base64Url(key);
    } finally {
      key.fill(0);
    }
  } catch {
    throw new Error(t("projects.memoryPackageUnlockFailed"));
  }
}

function sendChunk(
  path: string,
  bytes: Blob,
  signal: AbortSignal,
  progress: (loaded: number) => void,
  t: Translate,
): Promise<MemoryPackageUpload> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onerror = xhr.ontimeout = () => reject(new Error(t("harness.errorUnavailable")));
    xhr.onabort = () => reject(signal.reason);
    xhr.onload = () => {
      if (xhr.status === 401) void checkAuthentication({ force: true });
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response as MemoryPackageUpload);
      else reject(responseError(xhr.response, t));
    };
    xhr.open("POST", path);
    xhr.timeout = 120_000;
    xhr.responseType = "json";
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.send(bytes);
  });
}

export async function uploadMemoryPackage(
  path: string,
  file: File,
  current: MemoryPackageUpload,
  signal: AbortSignal,
  progress: (loaded: number) => void,
  t: Translate,
) {
  const { id, chunkBytes = memoryPackageChunkBytes } = current;
  let { offset } = current;
  progress(offset);
  while (offset < file.size) {
    const next = Math.min(offset + chunkBytes, file.size);
    const start = offset;
    const response = await sendChunk(
      path + "?" + new URLSearchParams({ upload: id, offset: String(start) }),
      file.slice(start, next),
      signal,
      (loaded) => progress(start + Math.min(loaded, next - start)),
      t,
    );
    if (response.id !== id || response.offset !== next) throw new Error(t("harness.errorUnavailable"));
    offset = next;
    progress(offset);
  }
}
