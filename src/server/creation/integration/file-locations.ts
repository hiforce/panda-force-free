import { join } from "node:path";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { CreationError } from "../contracts.js";
import { creationDigest, creationRecord, creationText, creationUuid } from "../validation.js";
import {
  authoredDigest,
  authoredOptional,
  authoredVersion,
  type CreationFileVersion,
} from "./authored-file-version-records.js";

export interface CreationLocatedFile extends CreationFileVersion {
  directoryIdentity?: string;
}
interface LocationLink {
  owner: string;
  conversationId: string;
  previous: string | null;
  version: CreationLocatedFile;
}
const key = (v: Pick<LocationLink, "owner" | "conversationId" | "previous">) =>
  authoredDigest(stableJson({ purpose: "creation-current-file", ...v }));
function link(value: unknown): LocationLink {
  const row = creationRecord(value, ["owner", "conversationId", "previous", "version"]),
    owner = creationText(row.owner, 200),
    data = creationRecord(row.version, [
      "schema",
      "owner",
      "id",
      "directory",
      "filename",
      "digest",
      "bytes",
      "previous",
      "directoryIdentity",
    ]),
    { directoryIdentity, ...source } = data,
    version = {
      ...authoredVersion(source),
      ...(directoryIdentity === undefined ? {} : { directoryIdentity: creationDigest(directoryIdentity) }),
    };
  if (version.owner !== owner) throw new CreationError("conflict");
  return {
    owner,
    conversationId: creationUuid(row.conversationId),
    previous: row.previous === null ? null : creationUuid(row.previous),
    version,
  };
}
/** Immutable successor records retain the current physical file independently of a selected writing round. */
export class CreationFileLocations {
  private readonly links: FilePackageContent<LocationLink>;
  constructor(root: string) {
    this.links = new FilePackageContent(join(root, "links"), {
      maxBytes: 16384,
      encode: async (v) => Buffer.from(stableJson(link(v))),
      decode: async (bytes) => link(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: (v) => key({ owner: v.owner, conversationId: v.conversationId, previous: v.previous }),
    });
  }
  async after(owner: string, conversationId: string, previous: string | null) {
    const found = await authoredOptional(this.links, key({ owner, conversationId, previous }));
    if (found && (found.owner !== owner || found.conversationId !== conversationId || found.previous !== previous))
      throw new CreationError("conflict");
    return found?.version ?? null;
  }
  async current(owner: string, conversationId: string) {
    let previous: string | null = null;
    let current: CreationLocatedFile | null = null;
    const seen = new Set<string>();
    for (;;) {
      const found: LocationLink | null = await authoredOptional(this.links, key({ owner, conversationId, previous }));
      if (!found) return current;
      if (
        found.owner !== owner ||
        found.conversationId !== conversationId ||
        found.previous !== previous ||
        seen.has(found.version.id) ||
        seen.size >= 2048
      )
        throw new CreationError("conflict");
      current = found.version;
      previous = found.version.id;
      seen.add(previous);
    }
  }
  async advance(owner: string, conversationId: string, previous: string | null, version: CreationLocatedFile) {
    const value = link({ owner, conversationId, previous, version });
    if (previous === version.id) throw new CreationError("conflict");
    await this.links.put(value);
    if (stableJson(await this.links.read(key({ owner, conversationId, previous }))) !== stableJson(value))
      throw new CreationError("conflict");
  }
}
