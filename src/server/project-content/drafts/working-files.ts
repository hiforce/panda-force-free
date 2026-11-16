import { join } from "node:path";
import type { OwnedProjectDirectory } from "../owned-directory.js";
import type { ProjectContentView } from "../read-view.js";
import { ensureContentDirectory, readContentFile, replaceContentFile } from "../working-files.js";
import { PROJECT_CONTENT_LIMITS } from "../limits.js";
import { ProjectContentError } from "../errors.js";
import { projectContentId } from "../paths.js";
import {
  decodeDraftFile,
  decodeDraftReceipt,
  encodeDraftReceipt,
  sameDraftReceipt,
  type ProjectDraftFile,
  type ProjectDraftReceipt,
} from "./file.js";

/** Mutable draft bodies and metadata-only receipts stay outside Git objects and share the project's write lease. */
export class ProjectDraftWorkingFiles {
  private readonly root: string;
  constructor(private readonly owned: OwnedProjectDirectory) {
    this.root = join(owned.directory, ".git", "panda");
  }
  private async prepare(view: ProjectContentView) {
    view.assertHeld();
    await this.owned.verify();
    for (const path of [this.root, join(this.root, "drafts"), join(this.root, "draft-receipts")])
      await ensureContentDirectory(path);
    view.assertHeld();
  }
  async receipt(view: ProjectContentView, id: string): Promise<ProjectDraftReceipt | null> {
    projectContentId(id);
    await this.prepare(view);
    const bytes = await readContentFile(join(this.root, "draft-receipts", id + ".json"), 16384),
      value = bytes === null ? null : decodeDraftReceipt(bytes);
    if (value && (value.operationId !== id || value.projectId !== this.owned.projectId))
      throw new ProjectContentError("invalidFile");
    view.assertHeld();
    return value;
  }
  async record(view: ProjectContentView, id: string): Promise<{ bytes: Buffer | null; file: ProjectDraftFile | null }> {
    projectContentId(id);
    await this.prepare(view);
    const bytes = await readContentFile(join(this.root, "drafts", id + ".json"), PROJECT_CONTENT_LIMITS.fileBytes),
      file = bytes === null ? null : decodeDraftFile(bytes);
    if (file && (file.documentId !== id || file.projectId !== this.owned.projectId))
      throw new ProjectContentError("invalidFile");
    view.assertHeld();
    // Recover the previous acknowledged generation before another writer can replace its body.
    if (file) await this.writeReceipt(view, file.lastOperation);
    return { bytes, file };
  }
  async writeReceipt(view: ProjectContentView, value: ProjectDraftReceipt): Promise<void> {
    const bytes = Buffer.from(encodeDraftReceipt(value)),
      existing = await this.receipt(view, value.operationId);
    if (existing) {
      if (!sameDraftReceipt(existing, value)) throw new ProjectContentError("conflict");
      return;
    }
    await replaceContentFile(join(this.root, "draft-receipts", value.operationId + ".json"), bytes, () =>
      view.assertHeld(),
    );
    view.assertHeld();
  }
  async replace(view: ProjectContentView, id: string, before: Buffer | null, after: string) {
    projectContentId(id);
    await this.prepare(view);
    const path = join(this.root, "drafts", id + ".json");
    const check = async () => {
      view.assertHeld();
      const current = await readContentFile(path, PROJECT_CONTENT_LIMITS.fileBytes);
      if (before === null ? current !== null : !current?.equals(before)) throw new ProjectContentError("conflict");
      view.assertHeld();
    };
    await check();
    await replaceContentFile(path, Buffer.from(after), check);
    view.assertHeld();
  }
}
