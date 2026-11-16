import type { SiteBuild } from "../../../shared/builds/jobs.js";
import { terminalBuildRun } from "../../../shared/builds/run.js";
import { LegacyHistoryContext, historyHash, historyJson, invalidHistory } from "./context.js";
import { inventoryLegacyBuildResources } from "./build-resources.js";

/** Historical build inputs may already be retired; their immutable source identities must still resolve. */
export function inventoryLegacyBuilds(c: LegacyHistoryContext): void {
  const version = c.domain("site_build_schema", 3, [
    ["site_builds", 1],
    ["site_build_resource_inputs", 3],
  ]);
  if (!version) return;
  if (version >= 2) c.legacyScope("site_builds", "projectId");
  for (const row of c.db
    .query<
      {
        id: string;
        spaceId: string;
        record: string;
        request: string;
        input: string | null;
        terminal: number;
        removed?: number;
        projectId?: string | null;
      },
      [string]
    >(`SELECT * FROM site_builds WHERE spaceId IN (${c.spaceFilter}) ORDER BY id`)
    .iterate(c.projectId)) {
    const build = historyJson<SiteBuild>(row.record);
    if (
      row.projectId != null ||
      build?.id !== row.id ||
      build.spaceId !== row.spaceId ||
      build.projectId !== undefined ||
      build.sourceSnapshot !== undefined ||
      row.terminal !== Number(terminalBuildRun(build)) ||
      !Array.isArray(build.sources)
    )
      return invalidHistory();
    for (const source of build.sources)
      c.source({ documentId: source.id, revisionId: source.revisionId, sourceHash: source.contentHash });
    if (row.input !== null && historyHash(row.input) !== build.inputHash) return invalidHistory();
    if (version >= 3) inventoryLegacyBuildResources(c, row, build);
    else if (build.inputProtocol !== undefined || build.nativeTheme !== undefined) return invalidHistory();
    if (!row.terminal) c.block("active-build", row.id, build.phase);
    c.archive("site_builds", row.id, row);
    c.builds.add(row.id);
  }
}
