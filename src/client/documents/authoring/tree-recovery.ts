import { storage, STORAGE_KEYS } from "../../storage.js";
import { isRecord } from "../../../shared/records.js";
import type { FrozenTreeCommand, TreeIntent } from "./tree-api.js";
import type { TreeRecovery } from "./tree-session.js";
import { documentTemplateRequest, DOCUMENT_TEMPLATE_INPUT_BYTES } from "../../../shared/templates/application.js";

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
function intent(value: unknown): value is TreeIntent {
  if (!isRecord(value)) return false;
  if (value.kind === "create" || value.kind === "create-template") {
    if (!text(value.title) || !text(value.locale) || !(value.parentId === null || text(value.parentId))) return false;
    if (value.kind === "create-template") {
      try {
        documentTemplateRequest({ template: value.template, values: value.values });
      } catch {
        return false;
      }
    }
    return true;
  }
  if (!text(value.documentId)) return false;
  if (value.kind === "rename")
    return text(value.title) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0;
  if (value.kind === "trash") return Number.isSafeInteger(value.revision) && Number(value.revision) > 0;
  if (value.kind === "restore") return value.toRoot === undefined || typeof value.toRoot === "boolean";
  if (value.kind !== "move" || !isRecord(value.target)) return false;
  return (
    value.target.kind === "root" ||
    (["before", "after", "inside"].includes(String(value.target.kind)) && text(value.target.documentId))
  );
}
/** Recovery retains bounded creation values when needed and stays isolated by identity, project and browser tab. */
export function treeRecovery(identity: string): TreeRecovery {
  const key = (project: string) => STORAGE_KEYS.documentTreeCommandFor(identity, project);
  return {
    read(project) {
      const value: unknown = storage.getSessionJson(key(project), null);
      if (
        !isRecord(value) ||
        !isRecord(value.command) ||
        typeof value.createdAt !== "number" ||
        Date.now() - value.createdAt > 7 * 86400000 ||
        value.createdAt > Date.now() + 3600000
      )
        return null;
      const c = value.command;
      if (
        JSON.stringify(c).length >
          (isRecord(c.intent) && c.intent.kind === "create-template" ? DOCUMENT_TEMPLATE_INPUT_BYTES + 8192 : 8192) ||
        !text(c.id) ||
        !/^[a-f0-9-]{36}$/i.test(c.id) ||
        c.projectId !== project ||
        !Number.isSafeInteger(c.treeVersion) ||
        Number(c.treeVersion) < 0 ||
        !intent(c.intent)
      )
        return null;
      return c as unknown as FrozenTreeCommand;
    },
    write(project, command) {
      if (command) storage.setSessionJson(key(project), { createdAt: Date.now(), command });
      else storage.removeSession(key(project));
    },
  };
}
