import { createHash } from "node:crypto";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { projectFilePath } from "./paths.js";
import { ProjectContentError } from "./errors.js";
import { withProjectGitLease, type ProjectGitLease } from "./git/lease.js";
import { recoverProjectContent } from "./recovery.js";
import { ProjectGitSnapshots, type ProjectFileChange } from "./git/snapshot.js";
import { ProjectContentJournal, type ContentMutationJournal } from "./journal.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { ProjectWorkingFiles } from "./working-files.js";
import { ProjectContentReadView } from "./read-view.js";
import { queueProjectContent } from "./queue.js";

import {
  contentChanges,
  contentCommand,
  contentRequestHash,
  commitContentMutation,
  type ProjectContentCommand,
} from "./mutation.js";

export interface ProjectContentMutation extends ProjectContentCommand {
  changes: readonly ProjectFileChange[];
  validateBefore?: (
    files: ReadonlyMap<string, Buffer | null>,
    view: ProjectContentReadView,
  ) => undefined | Promise<undefined>;
}
export interface PreparedProjectContent {
  changes: readonly ProjectFileChange[];
  message?: string;
}

/** Serializes one owned project's content; durable recovery is independent of application task databases. */
export class ProjectContentCoordinator {
  private readonly snapshots: ProjectGitSnapshots;
  private readonly journal: ProjectContentJournal;
  private readonly files: ProjectWorkingFiles;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly authorize: () => void | Promise<void> = () => {},
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
    this.journal = new ProjectContentJournal(owned);
    this.files = new ProjectWorkingFiles(owned);
  }

  private async exclusive<T>(work: (lease: ProjectGitLease) => Promise<T>): Promise<T> {
    return queueProjectContent(this.owned.directory, async () => {
      await this.owned.verify();
      return await withProjectGitLease(
        this.owned.directory,
        this.owned.coordination,
        async (lease) => {
          await this.recover(lease);
          await this.authorize();
          return work(lease);
        },
        { waitForLockMs: 25000 },
      );
    });
  }

  async read(paths: readonly string[]): Promise<{ commit: string; files: Map<string, Buffer | null> }> {
    const requested = [...new Set(paths.map(projectFilePath))];
    if (requested.length > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
    return this.view(async (view) => {
      const files = new Map<string, Buffer | null>();
      for (const path of requested) {
        files.set(path, await view.read(path));
      }
      return { commit: view.commit, files };
    });
  }

  async view<T>(work: (view: ProjectContentReadView) => Promise<T>): Promise<T> {
    return this.exclusive(async (lease) => this.viewAt(await this.snapshots.head(), lease, work));
  }

  private async viewAt<T>(commit: string, lease: ProjectGitLease, work: (view: ProjectContentReadView) => Promise<T>) {
    const entries = new Map((await this.snapshots.entries(commit)).map((row) => [row.path, row.blob])),
      view = new ProjectContentReadView(commit, entries, this.files, lease);
    try {
      return await work(view);
    } finally {
      view.close();
    }
  }

  private ports() {
    return { owned: this.owned, snapshots: this.snapshots, journal: this.journal, files: this.files };
  }

  async mutate(input: ProjectContentMutation): Promise<ContentMutationJournal> {
    const validateBefore = input.validateBefore,
      command = contentCommand(input),
      changes = contentChanges(input.changes);
    return this.exclusive(async (lease) => {
      const previous = await this.journal.receipt(command.operationId),
        base = command.base ?? previous?.base ?? (await this.snapshots.head());
      // Keep the original direct-mutation fingerprint unchanged for existing receipts and imports.
      const requestHash = contentRequestHash({
        ...command,
        base,
        changes: changes.map((row) => ({
          path: row.path,
          digest: row.content === null ? null : createHash("sha256").update(row.content).digest("hex"),
        })),
      });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ProjectContentError("conflict");
        return previous;
      }
      await this.authorize();
      return commitContentMutation(this.ports(), lease, command, base, requestHash, changes, validateBefore);
    });
  }

  /** Plan related files under one project lease. Replay checks the stable intent before invoking any planner. */
  transact(
    input: ProjectContentCommand & { intent: string },
    prepare: (view: ProjectContentReadView) => Promise<readonly ProjectFileChange[]>,
  ): Promise<ContentMutationJournal> {
    return this.planned(input, 1, async (view) => ({ changes: await prepare(view) }));
  }

  /** Derived revision metadata is built under the lease, while command identity remains stable across retries. */
  plan(
    input: ProjectContentCommand & { intent: string },
    prepare: (view: ProjectContentReadView) => Promise<PreparedProjectContent>,
  ): Promise<ContentMutationJournal> {
    return this.planned(input, 2, prepare);
  }

  /** Inspect an already authorized planned command without running its planner or creating a new mutation. */
  async plannedReceipt(
    input: ProjectContentCommand & { intent: string },
    missing?: () => Promise<void>,
  ): Promise<ContentMutationJournal | null> {
    const { command, intent } = this.plannedCommand(input);
    return this.exclusive(async () => {
      const previous = await this.journal.receipt(command.operationId);
      if (!previous) {
        await missing?.();
        return null;
      }
      if (
        previous.requestHash !==
        contentRequestHash({ ...command, base: command.base ?? previous.base, planSchema: 2, intent })
      )
        throw new ProjectContentError("conflict");
      return previous;
    });
  }

  private plannedCommand(input: ProjectContentCommand & { intent: string }) {
    const command = contentCommand(input),
      intent = input.intent;
    if (
      typeof intent !== "string" ||
      !intent ||
      intent.includes("\0") ||
      Buffer.byteLength(intent) > PROJECT_CONTENT_LIMITS.intentBytes
    )
      throw new ProjectContentError("invalidFile");
    return { command, intent };
  }

  private async planned(
    input: ProjectContentCommand & { intent: string },
    planSchema: 1 | 2,
    prepare: (view: ProjectContentReadView) => Promise<PreparedProjectContent>,
  ): Promise<ContentMutationJournal> {
    const { command, intent } = this.plannedCommand(input);
    return this.exclusive(async (lease) => {
      const previous = await this.journal.receipt(command.operationId),
        base = command.base ?? previous?.base ?? (await this.snapshots.head()),
        requestHash = contentRequestHash({ ...command, base, planSchema, intent });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ProjectContentError("conflict");
        return previous;
      }
      if ((await this.snapshots.head()) !== base) throw new ProjectContentError("conflict");
      const prepared = await this.viewAt(base, lease, prepare),
        changes = contentChanges(prepared.changes),
        derived = contentCommand({ ...command, message: prepared.message ?? command.message });
      // Preparation can await input; cached adapters must recheck authority before publishing its bytes.
      await this.authorize();
      return commitContentMutation(this.ports(), lease, derived, base, requestHash, changes);
    });
  }

  private recover(lease: ProjectGitLease): Promise<void> {
    return recoverProjectContent(
      { owned: this.owned, snapshots: this.snapshots, journal: this.journal, files: this.files },
      lease,
    );
  }
}
