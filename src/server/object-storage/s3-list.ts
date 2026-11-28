import { DOMParser } from "@xmldom/xmldom";
import type { StorageBrowserEntry } from "../../shared/workspace-tools/storage-browser.js";
import { ObjectStorageError } from "./contracts.js";

export function objectBrowserKey(key: string, directory = false) {
  const name = directory ? key.replace(/\/$/, "") : key;
  return (
    (directory ? key.endsWith("/") : !key.endsWith("/")) &&
    Buffer.byteLength(key) <= 1024 &&
    !/[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(key) &&
    name.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
const invalid = (): never => {
  throw new ObjectStorageError("storageIntegrity");
};

export function parseS3List(bytes: Uint8Array, prefix: string) {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return invalid();
  const root = new DOMParser({ onError: () => invalid() }).parseFromString(xml, "application/xml").documentElement;
  if (root?.localName !== "ListBucketResult") return invalid();
  const text = (element: typeof root, tag: string) =>
    element.getElementsByTagNameNS("*", tag).item(0)?.textContent ?? "";
  const encoded = text(root, "EncodingType") === "url";
  const entries: StorageBrowserEntry[] = [];
  for (let node = root.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as typeof root,
      folder = element.localName === "CommonPrefixes";
    if (!folder && element.localName !== "Contents") continue;
    const key = text(element, folder ? "Prefix" : "Key");
    // S3-compatible services can encode spaces as a literal plus. Encoded plus signs remain %2B.
    const id = encoded ? decodeURIComponent(key.replaceAll("+", " ")) : key;
    if (!id.startsWith(prefix)) return invalid();
    if (id === prefix || !objectBrowserKey(id, folder)) continue;
    const name = id.slice(prefix.length, folder ? -1 : undefined);
    if (!name || name.includes("/")) continue;
    if (folder) {
      entries.push({ kind: "folder", id, name });
      continue;
    }
    const size = text(element, "Size"),
      bytes = Number(size),
      modified = text(element, "LastModified");
    if (!/^\d+$/.test(size) || !Number.isSafeInteger(bytes)) return invalid();
    entries.push({
      kind: "file",
      id,
      name,
      bytes,
      ...(Number.isFinite(Date.parse(modified)) ? { modified } : {}),
      download: true,
    });
  }
  const truncated = text(root, "IsTruncated"),
    next = text(root, "NextContinuationToken");
  if (truncated !== "false" && (truncated !== "true" || !next || next.length > 8192)) return invalid();
  return { entries, next: truncated === "true" ? next : "" };
}
