import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectContentJournal } from "../../src/server/project-content/journal.js";
import { withProjectGitLease } from "../../src/server/project-content/git/lease.js";
import { syncContentDirectory } from "../../src/server/project-content/working-files.js";
import { projectDraftFixture, autosaveCommand, checkpointCommand } from "../support/project-draft-fixture.js";

test("checkpoint recovery reconciles the durable working copy after files or ref publication without a receipt", async () => {
  for (const phase of ["all-files", "published"] as const) {
    const f = await projectDraftFixture();
    try {
      await f.project.drafts.put(autosaveCommand());
      const command = checkpointCommand(),
        saved = await f.project.checkpoints.save(command),
        journal = new ProjectContentJournal(f.owned),
        receipt = await journal.receipt(command.operationId);
      expect(receipt).not.toBeNull();
      await withProjectGitLease(f.owned.directory, f.owned.coordination, async (lease) => {
        const directory = join(f.owned.directory, ".git", "panda", "receipts");
        await unlink(join(directory, command.operationId + ".json"));
        await syncContentDirectory(directory);
        if (phase === "all-files") await f.snapshots.publish(receipt!.commit, receipt!.base);
        await journal.writePending(receipt!, lease.assertHeld);
      });
      const reopened = new ProjectContentProject(f.owned),
        state = await reopened.drafts.get("doc-1");
      expect(state).toMatchObject({ version: 1, dirty: false, stale: false, baseRevisionId: saved.detail.revision.id });
      expect(await journal.pending()).toBeNull();
      expect(await journal.receipt(command.operationId)).toEqual(receipt);
      expect(await reopened.checkpoints.save(command)).toEqual(saved);
      expect(await f.snapshots.head()).toBe(saved.commit);
      expect(await reopened.documents.revisions("doc-1")).toHaveLength(2);
    } finally {
      await f.close();
    }
  }
}, 30000);
