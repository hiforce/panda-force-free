import { SearchError } from "../../../shared/search/contracts.js";
import type { PhysicalIndexResource } from "../resources/contracts.js";
import type { MilvusStorage } from "./milvus-storage.js";
import { createHash } from "node:crypto";
import { connectionFingerprint } from "../connection.js";
import type { PhysicalIndexStorage } from "../resources/contracts.js";

export function milvusResourceStorage(storage: MilvusStorage): PhysicalIndexStorage {
  return {
    id: createHash("sha256")
      .update(connectionFingerprint(storage.http.connection) + "/" + storage.collection("0".repeat(64)).slice(0, -64))
      .digest("hex"),
    inspect: (name, signal) => describeMilvusResource(storage, name, signal),
    inventory: (after, signal) => milvusInventory(storage, after, signal),
    async remove(name, signal) {
      await storage.request("collections/drop", { collectionName: storage.collection(name) }, signal);
    },
  };
}

/** Milvus lists a database at once. Admission is bounded locally; the cursor only limits subsequent describes. */
export async function milvusInventory(storage: MilvusStorage, after: string, signal: AbortSignal) {
  if (after && !/^[a-f0-9]{64}$/.test(after)) throw new SearchError("invalidInput");
  const data = (await storage.request("collections/list", {}, signal)).data;
  if (
    !Array.isArray(data) ||
    data.length > 8192 ||
    data.some((name) => typeof name !== "string" || name.length > 256) ||
    new Set(data).size !== data.length
  )
    throw new SearchError("unavailable", 503);
  const prefix = storage.collection("0".repeat(64)).slice(0, -64),
    names = data
      .filter((name: string) => name.startsWith(prefix) && /^[a-f0-9]{64}$/.test(name.slice(prefix.length)))
      .map((name: string) => name.slice(prefix.length))
      .sort(),
    batch = names.filter((name: string) => name > after).slice(0, 32);
  return {
    names: batch,
    next: names.some((name: string) => name > (batch.at(-1) ?? after)) ? batch.at(-1)! : null,
    ownedNamespaceCount: names.length,
  };
}

export async function describeMilvusResource(
  storage: MilvusStorage,
  name: string,
  signal: AbortSignal,
): Promise<PhysicalIndexResource | null> {
  if (!(await storage.exists(name, signal))) return null;
  const data = (await storage.request("collections/describe", { collectionName: storage.collection(name) }, signal))
    .data as Record<string, unknown> | undefined;
  if (
    !data ||
    data.collectionName !== storage.collection(name) ||
    typeof data.collectionID !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(data.collectionID) ||
    BigInt(data.collectionID) > 9223372036854775807n ||
    typeof data.description !== "string" ||
    data.description.length > 4096
  )
    throw new SearchError("unavailable", 503);
  return { name, identity: data.collectionID, marker: data.description };
}
