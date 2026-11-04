import { cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { git, verifySnapshot } from "./snapshot-lib.mjs";

/** Build a sanitized full-index patch; no private commits or messages are merged. */
export function prepareUpdate({ base, next, out, repo, apply = false }) {
  base = resolve(base);
  next = resolve(next);
  out = resolve(out);
  const previous = verifySnapshot(base),
    current = verifySnapshot(next);
  if (existsSync(out)) throw new Error("Patch destination already exists");
  if (apply && !repo) throw new Error("--apply requires a public repository");
  if (repo) {
    repo = resolve(repo);
    const target = relative(repo, out);
    if (target === "" || (!target.startsWith("..") && !target.startsWith("/")))
      throw new Error("Keep update patches outside the public checkout");
    if (git(repo, ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim())
      throw new Error("Public checkout must be clean, including untracked files");
  }
  const temporary = mkdtempSync(join(tmpdir(), "panda-update-"));
  try {
    cpSync(base, join(temporary, "a"), { recursive: true });
    cpSync(next, join(temporary, "b"), { recursive: true });
    const diff = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--binary",
        "--full-index",
        "--no-renames",
        "--src-prefix=",
        "--dst-prefix=",
        "--",
        "a",
        "b",
      ],
      { cwd: temporary, maxBuffer: 64 * 1024 * 1024 },
    );
    if (diff.error || ![0, 1].includes(diff.status)) throw diff.error || new Error(diff.stderr.toString());
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, diff.stdout, { flag: "wx", mode: 0o600 });
    if (apply && diff.stdout.length) {
      // Base blobs support three-way merging even without a shared commit ancestor.
      for (const file of [...previous.files, { path: "SNAPSHOT.json" }])
        git(repo, ["hash-object", "-w", "--stdin"], { input: readFileSync(join(base, file.path)) });
      try {
        git(repo, ["apply", "--3way", "--index", "--", out]);
      } catch {
        throw new Error(
          "Update was not committed: inspect git status and resolve conflicts manually; patch saved at " + out,
        );
      }
    }
    return {
      base: previous.contentSha256,
      next: current.contentSha256,
      patch: out,
      changed: diff.stdout.length > 0,
      applied: apply,
      committed: false,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2),
    get = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
  if (!get("--base") || !get("--next") || !get("--out"))
    throw new Error("Usage: --base OLD_EXPORT --next NEW_EXPORT --out PATCH [--repo PUBLIC_CHECKOUT --apply]");
  console.log(
    JSON.stringify(
      prepareUpdate({
        base: get("--base"),
        next: get("--next"),
        out: get("--out"),
        repo: get("--repo"),
        apply: args.includes("--apply"),
      }),
      null,
      2,
    ),
  );
}
