import type {
  CreationAvailability,
  CreationRequest,
  CreationTaskView,
  CreationTaskDetail,
} from "../../shared/creation/contracts.js";
import type { SkillRegistryPage } from "../../shared/skills/registry.js";
import { request } from "../http-client.js";

export class CreationApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Document creation request failed");
  }
}
async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    value: unknown = await response.json();
  if (!response.ok) throw new CreationApiError(response.status, value);
  if (body !== undefined) window.dispatchEvent(new Event("panda-force:creation-changed"));
  return value as T;
}
export function creationApiFor(project = "") {
  const prefix = (project === "personal" ? "/api/personal" : "/api") + "/document-creations";
  return {
    options: () => json<CreationAvailability>(prefix + "/options"),
    list: (project: string) => json<{ tasks: CreationTaskView[] }>(prefix + "?" + new URLSearchParams({ project })),
    detail: (id: string) => json<{ task: CreationTaskDetail }>(prefix + "/detail?" + new URLSearchParams({ id })),
    progress: (id: string) =>
      json<{ task: CreationTaskDetail }>(prefix + "/detail?" + new URLSearchParams({ id, view: "progress" })),
    followUp: (taskId: string, id: string, prompt: string) =>
      json<{ task: CreationTaskView }>(prefix + "/follow-up", { taskId, id, prompt }),
    submit: (body: CreationRequest) => json<{ task: CreationTaskView }>(prefix, body),
    cancel: (id: string) => json<{ task: CreationTaskView }>(prefix + "/cancel", { id }),
    retry: (id: string, operationId: string) =>
      json<{ task: CreationTaskView }>(prefix + "/retry", { id, operationId }),
    answer: (id: string, answers: unknown) => json<{ task: CreationTaskView }>(prefix + "/answer", { id, answers }),
    skill: (id: string, version: string) =>
      json<{ package: import("../../shared/skills/registry.js").InstalledSkillPack }>(
        "/api/skill-packs/detail?" + new URLSearchParams({ id, version }),
      ),
    skills: (cursor?: string) =>
      json<SkillRegistryPage>(
        "/api/skill-packs?" + new URLSearchParams({ view: "available", limit: "50", ...(cursor ? { cursor } : {}) }),
      ),
  };
}
export const creationApi = creationApiFor();
