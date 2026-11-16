import type { CliCapability } from "./contracts.js";
export const CLI_COMMANDS = [
  {
    id: "sources.list",
    words: ["sources", "list"],
    capability: "content:read",
    summary: "List saved document, web or slide originals with explicit kinds and a pagination head.",
    fields: ["project", "contentKinds", "search", "offset", "head"],
    required: ["project"],
  },
  {
    id: "sources.read",
    words: ["sources", "read"],
    capability: "content:read",
    summary: "Read verified saved-original text and sections, optionally pinned to an exact version.",
    fields: ["project", "id", "contentKinds", "sourceVersion"],
    required: ["project", "id"],
  },
  {
    id: "spaces.list",
    words: ["spaces", "list"],
    capability: "content:read",
    summary: "List document spaces available in an authorized project.",
    fields: ["project"],
    required: ["project"],
  },
  {
    id: "documents.list",
    words: ["documents", "list"],
    capability: "content:read",
    summary: "List saved documents in one authorized space.",
    fields: ["project", "space", "search", "offset"],
    required: ["project"],
  },
  {
    id: "documents.read",
    words: ["documents", "read"],
    capability: "content:read",
    summary: "Read a saved document and its exact version.",
    fields: ["project", "id"],
    required: ["project", "id"],
  },
  {
    id: "search.status",
    words: ["search", "status"],
    capability: "search:read",
    summary: "Read index readiness without running a search, creating an index or calling an embedding service.",
    fields: ["project"],
    required: ["project"],
  },
  {
    id: "search.query",
    words: ["search", "query"],
    capability: "search:read",
    summary: "Search saved documents by text, or approved knowledge with explicit semantic or hybrid mode.",
    fields: ["project", "query", "mode", "cursor"],
    required: ["project", "query"],
    semanticCapability: "knowledge:records:read",
  },
  {
    id: "knowledge.records.read",
    words: ["knowledge", "records", "read"],
    capability: "knowledge:records:read",
    summary: "Read approved project knowledge and its source evidence, without exposing private task state.",
    fields: ["project", "id"],
    required: ["project", "id"],
  },
  {
    id: "knowledge.list",
    words: ["knowledge", "list"],
    capability: "knowledge:read",
    summary: "List a page of your knowledge tasks in one authorized space.",
    fields: ["project", "cursor"],
    required: ["project"],
  },
  {
    id: "knowledge.status",
    words: ["knowledge", "status"],
    capability: "knowledge:read",
    summary: "Read task progress without loading its source bodies.",
    fields: ["project", "id"],
    required: ["project", "id"],
  },
  {
    id: "knowledge.read",
    words: ["knowledge", "read"],
    capability: "knowledge:read",
    summary: "Read your private knowledge task, draft, questions and outcome using its task ID.",
    fields: ["project", "id"],
    required: ["project", "id"],
  },
  {
    id: "knowledge.create",
    words: ["knowledge", "create"],
    capability: "knowledge:write",
    summary: "Create a reviewable knowledge task using a stable operation ID.",
    fields: ["project", "id", "ids", "purpose", "contentKinds"],
    required: ["project", "id", "ids", "purpose"],
  },
  {
    id: "knowledge.answer",
    words: ["knowledge", "answer"],
    capability: "knowledge:write",
    summary: "Answer pending knowledge questions.",
    fields: ["project", "id", "answers"],
    required: ["project", "id", "answers"],
  },
  {
    id: "knowledge.edit",
    words: ["knowledge", "edit"],
    capability: "knowledge:write",
    summary: "Edit a draft with its expected revision.",
    fields: ["project", "id", "revision", "draft"],
    required: ["project", "id", "revision", "draft"],
  },
  {
    id: "knowledge.approve",
    words: ["knowledge", "approve"],
    capability: "knowledge:approve",
    summary: "Approve the exact draft revision and save it to files and Git.",
    fields: ["project", "id", "revision", "previousState"],
    required: ["project", "id", "revision"],
  },
  {
    id: "knowledge.previous",
    words: ["knowledge", "previous"],
    capability: "knowledge:read",
    summary: "Read the saved knowledge snapshot captured by one of your private tasks.",
    fields: ["project", "id", "offset"],
    required: ["project", "id"],
  },
  {
    id: "knowledge.cancel",
    words: ["knowledge", "cancel"],
    capability: "knowledge:write",
    summary: "Cancel a knowledge task.",
    fields: ["project", "id"],
    required: ["project", "id"],
  },
  {
    id: "knowledge.retry",
    words: ["knowledge", "retry"],
    capability: "knowledge:write",
    summary: "Retry a failed knowledge task without duplicating its operation.",
    fields: ["project", "id"],
    required: ["project", "id"],
  },
] as const satisfies readonly {
  id: string;
  words: readonly string[];
  capability: CliCapability;
  summary: string;
  fields: readonly string[];
  required: readonly string[];
  semanticCapability?: CliCapability;
}[];
export type CliCommand = (typeof CLI_COMMANDS)[number];
export type CliCommandId = CliCommand["id"];
export const cliFlagName = (field: string) => field.replace(/[A-Z]/g, (char) => "-" + char.toLowerCase());
