import type { ProjectContentView } from "../../project-content/read-view.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { CREATIVE_ASSET_LIMITS as limits, type CreativeAsset } from "../../../shared/creative/assets.js";
import { creativeDigest, creativeAssetId } from "./codec.js";
import { creativeMetadata } from "./files.js";

export function creativeEntries(view: ProjectContentView) {
  return view.paths
    .filter((p) => p.startsWith("creations/"))
    .sort()
    .map((path) => ({
      path,
      id: creativeAssetId(path.slice("creations/".length, -".panda.json".length)),
      version: view.version(path)!,
    }));
}
/** Cursor binds the manifest inventory, not unrelated document/knowledge commits; listing never reads HTML or PPTX. */
export async function creativePage(
  view: ProjectContentView,
  project: string,
  cursor?: string,
  state: CreativeAsset["state"] = "saved",
) {
  const entries = creativeEntries(view),
    head = creativeDigest(JSON.stringify(entries));
  let offset = 0;
  if (cursor !== undefined) {
    if (cursor.length > 512) throw new ProjectContentError("invalidFile");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      throw new ProjectContentError("invalidFile");
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 4 ||
      decoded[0] !== project ||
      decoded[1] !== head ||
      decoded[3] !== state ||
      Buffer.from(JSON.stringify(decoded)).toString("base64url") !== cursor
    )
      throw new ProjectContentError("conflict");
    const found = entries.findIndex((e) => e.id === decoded[2]);
    if (found < 0) throw new ProjectContentError("conflict");
    offset = found + 1;
  }
  const selected = entries.slice(offset, offset + limits.page),
    assets: CreativeAsset[] = [];
  for (const row of selected) {
    const asset = await creativeMetadata(view, project, row.id, true);
    if (asset.state === state || (state === "trashed" && asset.state === "purging")) assets.push(asset);
  }
  return {
    assets,
    nextCursor:
      offset + selected.length < entries.length
        ? Buffer.from(JSON.stringify([project, head, selected.at(-1)!.id, state])).toString("base64url")
        : null,
  };
}
