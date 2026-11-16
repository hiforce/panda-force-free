import type { ContentAuthor } from "../git/process.js";
import { ProjectContentError } from "../errors.js";
import type { ProjectContentProject } from "../project.js";
import { decodeProjectLegacyImport, encodeProjectLegacyImport, type ProjectLegacyImportFile } from "./import-file.js";
import type { LegacyMetadataPlan } from "./metadata-plan.js";
import { contentRequestHash } from "../mutation.js";
import { stableJson } from "../../../shared/stable-json.js";

export const legacyImportOperation = (sourceHash: string, kind: string, identity: unknown) =>
  "import-" + contentRequestHash({ sourceHash, kind, identity });

/** Only a fresh owned target or the exact same import can enter this staged migration. */
export async function beginLegacyImport(
  project: ProjectContentProject,
  plan: LegacyMetadataPlan,
  author: ContentAuthor,
) {
  const content = encodeProjectLegacyImport(plan.marker),
    marker = decodeProjectLegacyImport(content);
  return project.coordinator.transact(
    {
      operationId: legacyImportOperation(marker.sourceHash, "begin", marker.projectId),
      author,
      message: "Begin project content migration",
      intent: contentRequestHash(marker),
    },
    async (view) => {
      const previous = await view.read("import.json");
      if (view.paths.length || previous !== null) throw new ProjectContentError("conflict");
      return [{ path: "import.json", content }];
    },
  );
}
export async function assertLegacyImportTarget(project: ProjectContentProject, plan: LegacyMetadataPlan) {
  const expected = stableJson(decodeProjectLegacyImport(encodeProjectLegacyImport(plan.marker))),
    paths = new Set(plan.paths);
  return project.coordinator.view(async (view) => {
    const bytes = await view.read("import.json");
    if (bytes === null) {
      if (view.paths.length) throw new ProjectContentError("conflict");
      return;
    }
    const marker = decodeProjectLegacyImport(bytes);
    if (stableJson({ ...marker, state: "importing" }) !== expected || view.paths.some((path) => !paths.has(path)))
      throw new ProjectContentError("conflict");
  });
}
export async function writeLegacyMetadataFile(
  project: ProjectContentProject,
  sourceHash: string,
  path: string,
  content: string,
  author: ContentAuthor,
) {
  return project.coordinator.mutate({
    operationId: legacyImportOperation(sourceHash, "metadata", path),
    author,
    message: "Import project content metadata",
    changes: [{ path, content }],
    validateBefore: async (files) => {
      const previous = files.get(path);
      if (previous !== null && previous?.toString() !== content) throw new ProjectContentError("conflict");
      return undefined;
    },
  });
}
export async function completeLegacyImport(
  project: ProjectContentProject,
  marker: ProjectLegacyImportFile,
  author: ContentAuthor,
  verifiedCommit: string,
) {
  const original = encodeProjectLegacyImport(marker),
    content = encodeProjectLegacyImport({ ...marker, state: "complete" });
  return project.coordinator.transact(
    {
      operationId: legacyImportOperation(marker.sourceHash, "complete", marker.projectId),
      author,
      message: "Complete project content migration",
      intent: contentRequestHash(marker),
    },
    async (view) => {
      if (view.commit !== verifiedCommit || (await view.read("import.json"))?.toString() !== original)
        throw new ProjectContentError("conflict");
      return [{ path: "import.json", content }];
    },
  );
}
