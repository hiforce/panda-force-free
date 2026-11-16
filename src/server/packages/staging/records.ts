import { createHash } from "node:crypto";
import { sourceOrigin } from "../../../shared/packages/sources/origin.js";
import { sourceLimits } from "../../../shared/packages/sources/contracts.js";
import type { SourceEntryPolicy } from "../../../shared/packages/sources/contracts.js";
import {
  SourceStageError,
  type SourceStageView,
  type SourceStageState,
  type SourceStagePurpose,
  type SourceStageFailure,
} from "../../../shared/packages/stages/contracts.js";
import { sourceStageRequest } from "../../../shared/packages/stages/input.js";

export interface SourceStageRow {
  entryPolicy: SourceEntryPolicy;
  id: string;
  actor: string;
  operationId: string;
  purpose: SourceStagePurpose;
  request: string;
  limits: string;
  fingerprint: string;
  revision: number;
  state: SourceStageState;
  reservedBytes: number;
  digest: string | null;
  origin: string | null;
  failure: SourceStageFailure | null;
  token: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export function stageView(row: SourceStageRow): SourceStageView {
  const limits = sourceLimits(JSON.parse(row.limits)),
    request = sourceStageRequest(JSON.parse(row.request), limits),
    fingerprint = createHash("sha256")
      .update(JSON.stringify({ purpose: row.purpose, request }))
      .digest("hex");
  if (fingerprint !== row.fingerprint) throw new SourceStageError("stageUnavailable");
  if (!["regular-only/v1", "logical-links/v2"].includes(row.entryPolicy))
    throw new SourceStageError("stageUnavailable");
  return Object.freeze({
    entryPolicy: row.entryPolicy,
    id: row.id,
    purpose: row.purpose,
    revision: row.revision,
    state: row.state,
    request,
    limits,
    reservedBytes: row.reservedBytes,
    digest: row.digest,
    origin: row.origin === null ? null : sourceOrigin(JSON.parse(row.origin)),
    failure: row.failure,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
export interface SourceStageCapacity {
  readonly ownerBytes: number;
  readonly globalBytes: number;
  readonly ownerItems: number;
  readonly globalItems: number;
}
export function stageCapacity(value?: SourceStageCapacity): SourceStageCapacity {
  const result = Object.freeze({
    ...(value ?? {
      ownerBytes: 512 * 1024 * 1024,
      globalBytes: 2 * 1024 * 1024 * 1024,
      ownerItems: 16,
      globalItems: 64,
    }),
  });
  if (
    Object.keys(result).length !== 4 ||
    Object.values(result).some((number) => !Number.isSafeInteger(number) || number <= 0)
  )
    throw new SourceStageError("stageInvalidInput");
  return result;
}
