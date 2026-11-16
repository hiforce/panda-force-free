import { stableJson } from "../../../shared/stable-json.js";
import { fileChoice, fileDigest, fileInteger, fileRecord, fileText } from "../codec-values.js";
import { ProjectContentError } from "../errors.js";
import { decodeContentJson, encodeContentJson } from "../json-file.js";
import { contentRequestHash } from "../mutation.js";
import { projectContentId } from "../paths.js";
import { draftContent, type ProjectDraftContent } from "./content.js";

export interface ProjectDraftReceipt {
  schema: 1;
  operationId: string;
  requestHash: string;
  projectId: string;
  documentId: string;
  actor: string;
  kind: "autosave" | "discard";
  version: number;
  baseRevisionId: string;
  stateHash: string;
  updatedAt: number;
}
export interface ProjectDraftFrame {
  schema: 1;
  projectId: string;
  documentId: string;
  spaceId: string;
  version: number;
  baseRevisionId: string;
  content: ProjectDraftContent | null;
  updatedAt: number;
}
export interface ProjectDraftFile extends ProjectDraftFrame {
  lastOperation: ProjectDraftReceipt;
}
function receipt(input: unknown): ProjectDraftReceipt {
  const v = fileRecord(input, [
    "schema",
    "operationId",
    "requestHash",
    "projectId",
    "documentId",
    "actor",
    "kind",
    "version",
    "baseRevisionId",
    "stateHash",
    "updatedAt",
  ]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  return {
    schema: 1,
    operationId: projectContentId(v.operationId),
    requestHash: fileDigest(v.requestHash),
    projectId: projectContentId(v.projectId),
    documentId: projectContentId(v.documentId),
    actor: fileText(v.actor, 800),
    kind: fileChoice(v.kind, ["autosave", "discard"]),
    version: fileInteger(v.version, 1),
    baseRevisionId: projectContentId(v.baseRevisionId),
    stateHash: fileDigest(v.stateHash),
    updatedAt: fileInteger(v.updatedAt),
  };
}
function file(input: unknown): ProjectDraftFile {
  const v = fileRecord(input, [
    "schema",
    "projectId",
    "documentId",
    "spaceId",
    "version",
    "baseRevisionId",
    "content",
    "updatedAt",
    "lastOperation",
  ]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  const frame: ProjectDraftFrame = {
      schema: 1,
      projectId: projectContentId(v.projectId),
      documentId: projectContentId(v.documentId),
      spaceId: projectContentId(v.spaceId),
      version: fileInteger(v.version, 1),
      baseRevisionId: projectContentId(v.baseRevisionId),
      content: v.content === null ? null : draftContent(v.content),
      updatedAt: fileInteger(v.updatedAt),
    },
    operation = receipt(v.lastOperation);
  if (
    operation.stateHash !== contentRequestHash(frame) ||
    operation.projectId !== frame.projectId ||
    operation.documentId !== frame.documentId ||
    operation.version !== frame.version ||
    operation.baseRevisionId !== frame.baseRevisionId ||
    operation.updatedAt !== frame.updatedAt ||
    (operation.kind === "discard") !== (frame.content === null)
  )
    throw new ProjectContentError("invalidFile");
  return { ...frame, lastOperation: operation };
}
export const encodeDraftFile = (value: ProjectDraftFile) => encodeContentJson(value, file);
export const decodeDraftFile = (bytes: Uint8Array | string) => decodeContentJson(bytes, file);
export const encodeDraftReceipt = (value: ProjectDraftReceipt) => encodeContentJson(value, receipt);
export const decodeDraftReceipt = (bytes: Uint8Array | string) => decodeContentJson(bytes, receipt);
export const sameDraftReceipt = (first: ProjectDraftReceipt, second: ProjectDraftReceipt) =>
  stableJson(first) === stableJson(second);
