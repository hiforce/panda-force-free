import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitDiff, readGitHistory, readGitStatus } from "../src/server/workspace/git.js";

function run(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(String(result.stderr));
  return String(result.stdout);
}

const root = mkdtempSync(join(tmpdir(), "codex-webui-git-"));
const repo = join(root, "repo");
mkdirSync(repo);
run(repo, ["init", "--initial-branch=main"]);
run(repo, ["config", "user.email", "test@example.com"]);
run(repo, ["config", "user.name", "Test"]);
writeFileSync(join(repo, "tracked.txt"), "one\n");
run(repo, ["add", "tracked.txt"]);
run(repo, ["commit", "-m", "initial commit"]);
writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
writeFileSync(join(repo, "untracked.txt"), "new\n");
const outside = mkdtempSync(join(tmpdir(), "codex-webui-git-outside-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("readGitStatus", () => {
  test("reports modified and untracked entries", () => {
    const status = readGitStatus(repo, [root]);
    const byPath = Object.fromEntries(status.entries.map((entry: any) => [entry.path, entry]));
    expect(byPath["tracked.txt"].worktreeStatus).toBe("M");
    expect(byPath["untracked.txt"].status).toBe("??");
  });

  test("rejects workspaces outside the allowed roots", () => {
    expect(() => readGitStatus(repo, [outside])).toThrow("outside allowed roots");
    expect(() => readGitStatus(outside, [outside])).toThrow(); // not a repository
  });
});

describe("readGitDiff", () => {
  test("produces a head diff for a modified file", () => {
    const diff = readGitDiff(repo, "tracked.txt", { allowedRoots: [root], scope: "head" });
    expect(diff.diff).toContain("+two");
    expect(diff.path).toBe("tracked.txt");
  });

  test("synthesizes a diff for untracked files", () => {
    const diff = readGitDiff(repo, "untracked.txt", { allowedRoots: [root], scope: "working" });
    expect(diff.diff).toContain("+new");
  });

  test("validates path and scope and commit inputs", () => {
    expect(() => readGitDiff(repo, "../escape.txt", { allowedRoots: [root] })).toThrow("Invalid Git path");
    expect(() => readGitDiff(repo, "/etc/passwd", { allowedRoots: [root] })).toThrow("Invalid Git path");
    expect(() => readGitDiff(repo, ".git/config", { allowedRoots: [root] })).toThrow("Invalid Git path");
    expect(() => readGitDiff(repo, "tracked.txt", { allowedRoots: [root], scope: "bogus" })).toThrow(
      "Invalid Git diff scope",
    );
    expect(() => readGitDiff(repo, "tracked.txt", { allowedRoots: [root], scope: "commit", commit: "xyz" })).toThrow(
      "Invalid Git commit",
    );
  });
});

describe("readGitHistory", () => {
  test("lists commits for a tracked file with clamped limits", () => {
    const history = readGitHistory(repo, "tracked.txt", { allowedRoots: [root], limit: 10 });
    expect(history.items.length).toBe(1);
    expect(history.items[0].subject).toBe("initial commit");
    expect(history.items[0].author).toBe("Test");
  });
});
