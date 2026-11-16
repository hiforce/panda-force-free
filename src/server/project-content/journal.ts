import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../../shared/stable-json.js";
import { projectContentId } from "./paths.js";
import { ProjectContentError } from "./errors.js";
import { projectFilePath } from "./paths.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { ensureContentDirectory, readContentFile, replaceContentFile, syncContentDirectory } from "./working-files.js";

export interface ContentMutationJournal {
  schema: 1;
  operationId: string;
  requestHash: string;
  base: string;
  commit: string;
  changes: { path: string; before: string | null; after: string | null }[];
}

function parse(bytes: Buffer): ContentMutationJournal {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as ContentMutationJournal;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["schema", "operationId", "requestHash", "base", "commit", "changes"].includes(key),
      ) ||
      value.schema !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.requestHash) ||
      !/^[a-f0-9]{40}$/.test(value.base) ||
      !/^[a-f0-9]{40}$/.test(value.commit) ||
      !Array.isArray(value.changes) ||
      value.changes.length > PROJECT_CONTENT_LIMITS.files
    )
      throw new ProjectContentError("invalidFile");
    projectContentId(value.operationId);
    const known = new Set<string>();
    for (const item of value.changes) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some((key) => !["path", "before", "after"].includes(key))
      )
        throw new ProjectContentError("invalidFile");
      projectFilePath(item.path);
      if (
        known.has(item.path) ||
        item.before === item.after ||
        [item.before, item.after].some(
          (hash) => hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{40}$/.test(hash)),
        )
      )
        throw new ProjectContentError("invalidFile");
      known.add(item.path);
    }
    if ((value.base === value.commit) !== (value.changes.length === 0)) throw new ProjectContentError("invalidFile");
    return value;
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
    throw new ProjectContentError("invalidFile");
  }
}

/** Durable metadata references Git objects; it never duplicates document bodies or attachment bytes. */
export class ProjectContentJournal {
  private readonly root: string;
  constructor(private readonly owned: OwnedProjectDirectory) {
    this.root = join(owned.directory, ".git", "panda");
  }

  private async prepare() {
    await this.owned.verify();
    await ensureContentDirectory(this.root);
    await ensureContentDirectory(join(this.root, "receipts"));
  }
  private async read(path: string) {
    const bytes = await readContentFile(path, PROJECT_CONTENT_LIMITS.journalBytes);
    return bytes === null ? null : parse(bytes);
  }
  async pending(): Promise<ContentMutationJournal | null> {
    await this.prepare();
    return this.read(join(this.root, "pending.json"));
  }
  async receipt(id: string): Promise<ContentMutationJournal | null> {
    await this.prepare();
    const value = await this.read(join(this.root, "receipts", projectContentId(id) + ".json"));
    if (value && value.operationId !== id) throw new ProjectContentError("invalidFile");
    return value;
  }
  async writePending(value: ContentMutationJournal, assertHeld: () => void): Promise<void> {
    await this.prepare();
    const bytes = Buffer.from(stableJson(value) + "\n");
    parse(bytes);
    if (await this.pending()) throw new ProjectContentError("conflict");
    await replaceContentFile(join(this.root, "pending.json"), bytes, async () => {
      if (await this.pending()) throw new ProjectContentError("conflict");
      assertHeld();
    });
  }
  async writeReceipt(value: ContentMutationJournal, assertHeld: () => void): Promise<void> {
    await this.prepare();
    const bytes = Buffer.from(stableJson(value) + "\n");
    parse(bytes);
    const existing = await this.receipt(value.operationId);
    if (existing) {
      if (stableJson(existing) !== stableJson(value)) throw new ProjectContentError("conflict");
      return;
    }
    await replaceContentFile(join(this.root, "receipts", value.operationId + ".json"), bytes, assertHeld);
  }
  async clearPending(value: ContentMutationJournal, assertHeld: () => void): Promise<void> {
    const pending = await this.pending();
    if (!pending) return;
    if (stableJson(pending) !== stableJson(value)) throw new ProjectContentError("conflict");
    assertHeld();
    await unlink(join(this.root, "pending.json"));
    await syncContentDirectory(this.root);
  }
}
