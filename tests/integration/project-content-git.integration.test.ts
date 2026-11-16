import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectGit, ProjectGitError } from "../../src/server/project-content/git/process.js";
import { withProjectGitLease } from "../../src/server/project-content/git/lease.js";

const author = { name: "Content author", email: "content@example.test" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "panda-owned-git-"));
  await projectGit(directory, ["init", "--template=", "--initial-branch=content"]);
  const tree = (await projectGit(directory, ["mktree"], { input: "" })).toString().trim();
  const commit = (
    await projectGit(directory, ["commit-tree", tree], { input: "Initial project content\n", identity: author })
  )
    .toString()
    .trim();
  await projectGit(directory, ["update-ref", "refs/heads/content", commit]);
  await projectGit(directory, ["update-ref", "refs/panda/coordination", commit]);
  return { directory, commit, close: () => rm(directory, { recursive: true, force: true }) };
}

test("Git plumbing preserves author identity, ignores repository hooks and bounds returned content", async () => {
  const f = await fixture();
  try {
    const hooks = join(f.directory, "hooks"),
      trap = join(f.directory, "unexpected-hook");
    await mkdir(hooks);
    await writeFile(join(hooks, "reference-transaction"), "#!/bin/sh\ntouch '" + trap + "'\n", { mode: 0o755 });
    await projectGit(f.directory, ["config", "core.hooksPath", hooks]);
    await projectGit(f.directory, ["update-ref", "refs/heads/another", f.commit]);
    expect(await Bun.file(trap).exists()).toBe(false);
    expect((await projectGit(f.directory, ["cat-file", "-p", f.commit])).toString()).toContain(
      "author Content author <content@example.test>",
    );
    const blob = (
      await projectGit(f.directory, ["hash-object", "-w", "--stdin", "--no-filters"], { input: "x".repeat(4096) })
    )
      .toString()
      .trim();
    await expect(projectGit(f.directory, ["cat-file", "blob", blob], { bytes: 64 })).rejects.toBeInstanceOf(
      ProjectGitError,
    );
    await expect(projectGit(f.directory, ["cat-file", "blob", "0".repeat(40)])).rejects.toMatchObject({
      code: "failed",
    });
  } finally {
    await f.close();
  }
});

test("prepared project exclusion rejects a competing owner and releases after success or callback failure", async () => {
  const f = await fixture();
  try {
    await withProjectGitLease(f.directory, f.commit, async (lease) => {
      lease.assertHeld();
      expect((await stat(join(f.directory, ".git/refs/panda/coordination.lock"))).isFile()).toBe(true);
      await expect(withProjectGitLease(f.directory, f.commit, async () => "unexpected")).rejects.toBeInstanceOf(
        ProjectGitError,
      );
    });
    await expect(
      withProjectGitLease(f.directory, f.commit, async () => {
        throw Error("Draft failed");
      }),
    ).rejects.toThrow("Draft failed");
    expect(await withProjectGitLease(f.directory, f.commit, async () => "next owner")).toBe("next owner");
  } finally {
    await f.close();
  }
});

test("coordinators may opt into bounded native lock waiting without stealing or replaying another transaction", async () => {
  const f = await fixture();
  let release: () => void = () => {},
    entered: () => void = () => {},
    held = false;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  let first: Promise<void> | undefined;
  try {
    first = withProjectGitLease(f.directory, f.commit, async () => {
      held = true;
      entered();
      await gate;
      held = false;
    });
    await ready;
    const second = withProjectGitLease(
      f.directory,
      f.commit,
      async () => {
        expect(held).toBeFalse();
        return "next";
      },
      { prepareTimeoutMs: 2000, waitForLockMs: 1000 },
    );
    await Bun.sleep(50);
    release();
    expect(await second).toBe("next");
    await first;
    expect((await projectGit(f.directory, ["rev-parse", "refs/panda/coordination"])).toString().trim()).toBe(f.commit);
    await expect(
      withProjectGitLease(f.directory, f.commit, async () => null, { prepareTimeoutMs: 100, waitForLockMs: 100 }),
    ).rejects.toBeInstanceOf(ProjectGitError);
  } finally {
    release();
    await first;
    await f.close();
  }
});

test("a lost lock process cannot return a successful content operation", async () => {
  const f = await fixture();
  try {
    await expect(
      withProjectGitLease(f.directory, f.commit, async (lease) => {
        process.kill(lease.processId, "SIGTERM");
        await new Promise<void>((resolve) => {
          if (lease.signal.aborted) resolve();
          else lease.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "not committed";
      }),
    ).rejects.toThrow();
    expect(await withProjectGitLease(f.directory, f.commit, async () => "recovered exclusion")).toBe(
      "recovered exclusion",
    );
  } finally {
    await f.close();
  }
});

test("an unresponsive lock process has a bounded release and its orphan lock is never silently removed", async () => {
  const f = await fixture();
  try {
    await expect(
      withProjectGitLease(
        f.directory,
        f.commit,
        async (lease) => {
          process.kill(lease.processId, "SIGSTOP");
          return "not acknowledged";
        },
        { releaseTimeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: "lockLost" });
    expect(await Bun.file(join(f.directory, ".git/refs/panda/coordination.lock")).exists()).toBe(true);
    await expect(withProjectGitLease(f.directory, f.commit, async () => "unsafe takeover")).rejects.toBeInstanceOf(
      ProjectGitError,
    );
  } finally {
    await f.close();
  }
});
