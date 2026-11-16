import { createHash } from "node:crypto";
import { stableJson } from "../../shared/stable-json.js";
import { ProjectContentError } from "./errors.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { projectContentId, projectFilePath } from "./paths.js";
import type { ContentAuthor } from "./git/process.js";
import type { ProjectFileChange } from "./git/snapshot.js";
import type { ContentMutationJournal } from "./journal.js";
import { ProjectContentReadView } from "./read-view.js";
import { recoverProjectContent } from "./recovery.js";
import type { ProjectGitLease } from "./git/lease.js";

export interface ProjectContentCommand {
  operationId: string;
  base?: string;
  author: ContentAuthor;
  message: string;
}
export const contentRequestHash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");

export function contentCommand(input: ProjectContentCommand): ProjectContentCommand {
  projectContentId(input.operationId);
  if (
    (input.base !== undefined && !/^[a-f0-9]{40}$/.test(input.base)) ||
    !input.message ||
    input.message.includes("\0") ||
    Buffer.byteLength(input.message) > 16384
  )
    throw new ProjectContentError("invalidFile");
  return {
    operationId: input.operationId,
    base: input.base,
    message: input.message,
    author: { name: input.author.name, email: input.author.email },
  };
}

export function contentChanges(input: readonly ProjectFileChange[]) {
  if (input.length > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
  let total = 0;
  const seen = new Set<string>();
  return input.map((row) => {
    const content = row.content === null ? null : Buffer.from(row.content),
      path = projectFilePath(row.path);
    total += content?.length || 0;
    if (
      seen.has(path) ||
      total > PROJECT_CONTENT_LIMITS.operationBytes ||
      (content?.length || 0) > PROJECT_CONTENT_LIMITS.fileBytes
    )
      throw new ProjectContentError("invalidFile");
    seen.add(path);
    return { path, content };
  });
}

/** A prepared domain plan and a direct mutation use the same journal, original checks and recovery path. */
export async function commitContentMutation(
  ports: Parameters<typeof recoverProjectContent>[0],
  lease: ProjectGitLease,
  command: ProjectContentCommand,
  base: string,
  requestHash: string,
  changes: ReturnType<typeof contentChanges>,
  validateBefore?: (
    files: ReadonlyMap<string, Buffer | null>,
    view: ProjectContentReadView,
  ) => undefined | Promise<undefined>,
): Promise<ContentMutationJournal> {
  const { snapshots, journal: store, files } = ports;
  if ((await snapshots.head()) !== base) throw new ProjectContentError("conflict");
  const before = new Map((await snapshots.entries(base)).map((row) => [row.path, row.blob])),
    originals = new Map<string, Buffer | null>(),
    view = new ProjectContentReadView(base, before, files, lease);
  try {
    for (const row of changes) originals.set(row.path, await view.read(row.path));
    // Domain guards share the write lease and must not re-enter their coordinator.
    await validateBefore?.(originals, view);
  } finally {
    view.close();
  }
  lease.assertHeld();
  const prepared = await snapshots.prepare(
    base,
    changes,
    command.author,
    command.message + "\n\nPanda-Operation: " + command.operationId + "\nPanda-Request: " + requestHash,
  );
  const after = new Map(prepared.entries.map((row) => [row.path, row.blob]));
  const journal: ContentMutationJournal = {
    schema: 1,
    operationId: command.operationId,
    requestHash,
    base,
    commit: prepared.commit,
    changes: [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path))
      .sort()
      .map((path) => ({ path, before: before.get(path) || null, after: after.get(path) || null })),
  };
  lease.assertHeld();
  if (!prepared.changed) await store.writeReceipt(journal, lease.assertHeld);
  else {
    await store.writePending(journal, lease.assertHeld);
    await recoverProjectContent(ports, lease);
  }
  return journal;
}
