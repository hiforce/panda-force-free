import { stableJson } from "../../shared/stable-json.js";
import { ProjectContentError } from "./errors.js";
import { projectBlobHash } from "./git/blob-hash.js";
import type { ProjectGitLease } from "./git/lease.js";
import { projectGit, ProjectGitError } from "./git/process.js";
import type { ProjectGitSnapshots } from "./git/snapshot.js";
import type { ProjectContentJournal } from "./journal.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import type { ProjectWorkingFiles } from "./working-files.js";

/** Reconcile only a durable prepared change, refusing every worktree state outside its old/new images. */
export async function recoverProjectContent(
  dependencies: {
    owned: OwnedProjectDirectory;
    snapshots: ProjectGitSnapshots;
    journal: ProjectContentJournal;
    files: ProjectWorkingFiles;
  },
  lease: ProjectGitLease,
): Promise<void> {
  const { owned, snapshots, journal: store, files } = dependencies,
    journal = await store.pending();
  if (!journal) return;
  const head = await snapshots.head();
  if (head !== journal.base && head !== journal.commit) throw new ProjectContentError("conflict");
  const before = new Map((await snapshots.entries(journal.base)).map((row) => [row.path, row.blob])),
    after = new Map((await snapshots.entries(journal.commit)).map((row) => [row.path, row.blob]));
  const actualChanges = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort()
    .map((path) => ({ path, before: before.get(path) || null, after: after.get(path) || null }));
  if (stableJson(actualChanges) !== stableJson(journal.changes)) throw new ProjectContentError("invalidFile");
  for (const row of journal.changes) {
    const bytes = await files.read(row.path),
      actual = bytes === null ? null : projectBlobHash(bytes);
    if ((actual !== row.before && actual !== row.after) || (head === journal.commit && actual !== row.after))
      throw new ProjectContentError("conflict");
    lease.assertHeld();
  }
  let pin: string | null = null;
  try {
    pin = (await projectGit(owned.directory, ["rev-parse", "--verify", "--quiet", "refs/panda/pending"]))
      .toString()
      .trim();
  } catch (error) {
    if (!(error instanceof ProjectGitError) || error.status !== 1) throw error;
  }
  if (pin !== null && pin !== journal.commit) throw new ProjectContentError("conflict");
  lease.assertHeld();
  await projectGit(owned.directory, ["update-ref", "refs/panda/pending", journal.commit, pin || "0".repeat(40)]);
  // Validate the complete recovery plan first, then hold at most one replacement body in memory.
  for (const row of journal.changes) {
    const actual = await files.read(row.path),
      hash = actual === null ? null : projectBlobHash(actual);
    if (hash !== row.after) {
      if (hash !== row.before) throw new ProjectContentError("conflict");
      const next = row.after === null ? null : await snapshots.content(row.after);
      await files.replace(row.path, actual, next, lease.assertHeld);
    }
    lease.assertHeld();
  }
  if (head === journal.base) await snapshots.publish(journal.base, journal.commit);
  lease.assertHeld();
  await store.writeReceipt(journal, lease.assertHeld);
  await projectGit(owned.directory, ["update-ref", "-d", "refs/panda/pending", journal.commit]);
  await store.clearPending(journal, lease.assertHeld);
}
