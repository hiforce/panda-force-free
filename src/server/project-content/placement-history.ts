import type { DocumentPlacementHistorySummary } from "../../shared/documents/placements.js";
import { stableJson } from "../../shared/stable-json.js";
import { ProjectContentError } from "./errors.js";
import { readContentHistory } from "./git/history.js";
import { contentRequestHash } from "./mutation.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { projectContentId } from "./paths.js";
import { decodeProjectPlacement, projectPlacementFile, type ProjectPlacementFile } from "./placement-file.js";
import { fileDigest, fileRecord } from "./codec-values.js";

export type ProjectPlacementEventSummary = DocumentPlacementHistorySummary;
export interface ProjectPlacementHistoryEntry {
  commit: string;
  summary: ProjectPlacementEventSummary;
}
const metadataPrefix = "Panda-Placement-Metadata: ";
export function placementEventSummary(value: ProjectPlacementFile): ProjectPlacementEventSummary {
  const { metadata, ...placement } = value.placement;
  void metadata;
  return { placement, audit: value.audit, recordHash: contentRequestHash(value) };
}
export function placementCommitMessage(value: ProjectPlacementFile) {
  return (
    "Save document publication placement\n\nPanda-Placement: " +
    projectContentId(value.placement.id) +
    "\nPanda-Placement-Version: " +
    value.placement.version +
    "\n" +
    metadataPrefix +
    Buffer.from(stableJson(placementEventSummary(value))).toString("base64url")
  );
}
function summary(message: string, id: string): ProjectPlacementEventSummary {
  const lines = message.split("\n"),
    rows = lines.filter((line) => line.startsWith(metadataPrefix));
  if (rows.length !== 1) throw new ProjectContentError("invalidFile");
  const encoded = rows[0]!.slice(metadataPrefix.length);
  if (!encoded || encoded.length > 8192 || !/^[a-zA-Z0-9_-]+$/.test(encoded))
    throw new ProjectContentError("invalidFile");
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new ProjectContentError("invalidFile");
    const value = fileRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), [
        "placement",
        "audit",
        "recordHash",
      ]),
      placement = fileRecord(value.placement, [
        "id",
        "projectId",
        "documentId",
        "spaceId",
        "path",
        "locale",
        "revisionId",
        "version",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
      decoded = decodeProjectPlacement(
        JSON.stringify({ schema: 1, placement: { ...placement, metadata: {} }, audit: value.audit }),
      ),
      { metadata, ...header } = decoded.placement;
    void metadata;
    if (
      header.id !== id ||
      lines.filter((line) => line.startsWith("Panda-Placement: ")).join() !== "Panda-Placement: " + id ||
      lines.filter((line) => line.startsWith("Panda-Placement-Version: ")).join() !==
        "Panda-Placement-Version: " + header.version
    )
      throw new ProjectContentError("invalidFile");
    return { placement: header, audit: decoded.audit, recordHash: fileDigest(value.recordHash) };
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
    throw new ProjectContentError("invalidFile");
  }
}

/** Listing reads compact commit summaries; opening an event validates its complete immutable record separately. */
export class ProjectPlacementHistory {
  constructor(private readonly owned: OwnedProjectDirectory) {}
  async list(id: string, commit: string, limit = 100, version?: number): Promise<ProjectPlacementHistoryEntry[]> {
    projectContentId(id);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
      throw new ProjectContentError("invalidFile");
    const rows = await readContentHistory(this.owned, {
        path: projectPlacementFile(id),
        commit,
        limit,
        patterns: [
          "^Panda-Placement: " + id + "$",
          ...(version === undefined ? [] : ["^Panda-Placement-Version: " + version + "$"]),
        ],
      }),
      versions = new Set<number>();
    let previous: ProjectPlacementEventSummary | undefined;
    return rows.map((row) => {
      const record = summary(row.message, id);
      if (record.placement.projectId !== this.owned.projectId || versions.has(record.placement.version))
        throw new ProjectContentError("invalidFile");
      if (
        previous &&
        (previous.placement.version !== record.placement.version + 1 ||
          ["documentId", "spaceId", "createdAt"].some(
            (key) => Reflect.get(previous!.placement, key) !== Reflect.get(record.placement, key),
          ) ||
          record.audit.operation === "remove")
      )
        throw new ProjectContentError("invalidFile");
      versions.add(record.placement.version);
      previous = record;
      return { commit: row.commit, summary: record };
    });
  }
}
