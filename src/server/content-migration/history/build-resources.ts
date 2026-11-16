import type { SiteBuild, SiteBuildRequest } from "../../../shared/builds/jobs.js";
import { RESOURCE_FRAME_MAX } from "../../../shared/builds/resource-frame.js";
import {
  templateDigest,
  templateId,
  templateVersion,
  templateText,
} from "../../../shared/templates/portable/validation.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";
import { LegacyHistoryContext, historyJson, invalidHistory } from "./context.js";

/** Inventory resource receipts without reopening immutable input files or granting new execution permission. */
export function inventoryLegacyBuildResources(
  c: LegacyHistoryContext,
  row: { id: string; request: string; input: string | null; removed?: number; terminal: number },
  build: SiteBuild,
) {
  const resource = c.db
    .query<{ id: string; owner: string; ready: number; reservedBytes: number }, [string]>(
      "SELECT * FROM site_build_resource_inputs WHERE id=?",
    )
    .get(row.id);
  if (row.removed !== 0 && row.removed !== 1) return invalidHistory();
  if (build.inputProtocol === undefined) {
    if (resource || build.nativeTheme !== undefined || row.removed !== 0) return invalidHistory();
    return;
  }
  if (
    build.inputProtocol !== 2 ||
    !resource ||
    !build.nativeTheme ||
    build.theme !== undefined ||
    row.input !== null ||
    (row.removed === 1 && row.terminal !== 1) ||
    ![0, 1].includes(resource.ready) ||
    !Number.isSafeInteger(resource.reservedBytes) ||
    resource.reservedBytes < 0 ||
    resource.reservedBytes > RESOURCE_FRAME_MAX ||
    (!row.terminal && resource.reservedBytes === 0)
  )
    return invalidHistory();
  const request = historyJson<SiteBuildRequest>(row.request),
    theme = build.nativeTheme;
  try {
    if (
      request.id !== build.id ||
      request.spaceId !== build.spaceId ||
      request.engine !== build.engine ||
      request.nativeTheme?.id !== templateId(theme.id) ||
      request.nativeTheme?.version !== templateVersion(theme.version) ||
      request.nativeTheme?.digest !== templateDigest(theme.digest)
    )
      return invalidHistory();
    templateDigest(build.inputHash);
    templateText(resource.owner, 200);
    templateText(theme.engineVersion, 100);
    templateDigest(theme.source.digest);
    templateDigest(theme.source.projectionDigest);
    if (theme.source.root !== "") sourcePath(theme.source.root);
  } catch {
    return invalidHistory();
  }
  c.archive("site_build_resource_inputs", row.id, resource);
}
