import { request } from "../http-client.js";
import type { SourceStagePurpose, SourceStageView } from "../../shared/packages/stages/contracts.js";
import type { SourceLimits } from "../../shared/packages/sources/contracts.js";
import type { SourceSnapshotDescriptor } from "../../shared/packages/sources/snapshot.js";
import type { TemplateSourceInspection } from "../../shared/templates/sources/contracts.js";

export class SourceApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Source request failed");
  }
}
async function call<T>(path: string, options?: RequestInit): Promise<T> {
  return sourceResponse<T>(await request("/api/package-sources" + path, options));
}
async function sourceResponse<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) throw new SourceApiError(response.status, value);
  return value as T;
}
export async function inspectTemplateSource(id: string) {
  return sourceResponse<TemplateSourceInspection>(
    await request("/api/templates/source-discovery?" + new URLSearchParams({ id })),
  );
}
function json<T>(path: string, body: unknown) {
  return call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
export function sourceImportApi(purpose: SourceStagePurpose) {
  const identity = (id: string) => new URLSearchParams({ purpose, id });
  return {
    policy: (signal?: AbortSignal) => call<{ limits: SourceLimits }>("/policy", { signal }),
    list: (signal?: AbortSignal) => call<SourceStageView[]>("?" + new URLSearchParams({ purpose }), { signal }),
    submit: (operationId: string, input: unknown) =>
      json<SourceStageView>("", { purpose, operationId, request: input }),
    task: (id: string) => call<SourceStageView>("/task?" + identity(id)),
    inspect: (id: string) => call<SourceSnapshotDescriptor>("/inspect?" + identity(id)),
    upload: (task: SourceStageView, file: File) =>
      call<SourceStageView>(
        "/upload?" +
          new URLSearchParams({
            purpose,
            id: task.id,
            revision: String(task.revision),
          }),
        { method: "POST", headers: { "content-type": "application/zip" }, body: file },
      ),
    cancel: (task: SourceStageView) =>
      json<SourceStageView>("/cancel", { purpose, id: task.id, revision: task.revision }),
    remove: (task: SourceStageView) =>
      json<SourceStageView>("/remove", { purpose, id: task.id, revision: task.revision }),
  };
}
export async function sourceFileDigest(file: File): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
