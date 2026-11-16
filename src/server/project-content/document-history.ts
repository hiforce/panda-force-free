import type { DocumentRevision } from "../../shared/documents/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import { ProjectContentError } from "./errors.js";
import { projectGit } from "./git/process.js";
import { readContentHistory } from "./git/history.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { projectContentId, projectDocumentFile } from "./paths.js";

export type ProjectRevisionSummary = Pick<
  DocumentRevision,
  "id" | "documentId" | "number" | "title" | "locale" | "contentHash" | "createdAt"
>;
export function projectRevisionSummary(value: DocumentRevision): ProjectRevisionSummary {
  const { id, documentId, number, title, locale, contentHash, createdAt } = value;
  return { id, documentId, number, title, locale, contentHash, createdAt };
}
export function revisionCommitMessage(value: DocumentRevision): string {
  return (
    "Save project document revision\n\nPanda-Document: " +
    projectContentId(value.documentId) +
    "\nPanda-Revision: " +
    projectContentId(value.id) +
    "\nPanda-Revision-Metadata: " +
    Buffer.from(stableJson(projectRevisionSummary(value))).toString("base64url")
  );
}

function summary(message: string, documentId: string): ProjectRevisionSummary {
  const lines = message.split("\n"),
    prefix = "Panda-Revision-Metadata: ",
    rows = lines.filter((line) => line.startsWith(prefix));
  if (rows.length !== 1) throw new ProjectContentError("invalidFile");
  const encoded = rows[0]!.slice(prefix.length);
  if (encoded.length > 8192 || !/^[a-zA-Z0-9_-]+$/.test(encoded)) throw new ProjectContentError("invalidFile");
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new ProjectContentError("invalidFile");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ProjectRevisionSummary;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !==
        ["id", "documentId", "number", "title", "locale", "contentHash", "createdAt"].sort().join() ||
      projectContentId(value.id) !== value.id ||
      value.documentId !== documentId ||
      !Number.isSafeInteger(value.number) ||
      value.number < 1 ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      typeof value.title !== "string" ||
      !value.title.trim() ||
      Buffer.byteLength(value.title) > 2000 ||
      value.title.includes("\0") ||
      typeof value.locale !== "string" ||
      !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.locale) ||
      value.locale.length > 35 ||
      typeof value.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.contentHash) ||
      lines.filter((line) => line === "Panda-Document: " + documentId).length !== 1 ||
      lines.filter((line) => line === "Panda-Revision: " + value.id).length !== 1
    )
      throw new ProjectContentError("invalidFile");
    return value;
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
    throw new ProjectContentError("invalidFile");
  }
}

/** Listing reads bounded commit metadata only; opening a selected revision reads its immutable original separately. */
export class ProjectDocumentHistory {
  constructor(private readonly owned: OwnedProjectDirectory) {}
  /** Revision identity is project-wide, including versions no longer current on another document. */
  async hasRevision(revisionId: string): Promise<boolean> {
    projectContentId(revisionId);
    await this.owned.verify();
    const value = (
      await projectGit(
        this.owned.directory,
        [
          "log",
          "--format=%H",
          "--max-count=1",
          "--extended-regexp",
          "--grep=^Panda-Revision: " + revisionId + "$",
          "refs/heads/content",
        ],
        { bytes: 128 },
      )
    )
      .toString()
      .trim();
    if (value && !/^[a-f0-9]{40}$/.test(value)) throw new ProjectContentError("invalidFile");
    return !!value;
  }
  async list(
    id: string,
    revisionId?: string,
    limit = 100,
    commit?: string,
  ): Promise<{ commit: string; revision: ProjectRevisionSummary }[]> {
    const path = projectDocumentFile(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ProjectContentError("invalidFile");
    const match =
      "^Panda-Revision: " + (revisionId === undefined ? "[A-Za-z0-9_-]+" : projectContentId(revisionId)) + "$";
    const rows = await readContentHistory(this.owned, { path, patterns: [match], limit, commit }),
      result: { commit: string; revision: ProjectRevisionSummary }[] = [],
      ids = new Set<string>();
    for (const { commit, message } of rows) {
      const revision = summary(message, id);
      if (ids.has(revision.id)) throw new ProjectContentError("invalidFile");
      ids.add(revision.id);
      result.push({ commit, revision });
    }
    return result;
  }
}
