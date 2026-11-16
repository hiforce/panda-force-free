import { SourceError, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import { sourcePath, SourcePaths } from "../../../shared/packages/sources/paths.js";
import { GitHubSourceClient, githubObject, gitSha } from "./client.js";

export interface GitTreeEntry {
  path: string;
  sha: string;
  kind: "file" | "directory" | "symlink" | "gitlink";
  bytes: number;
}
async function tree(
  client: GitHubSourceClient,
  sha: string,
  recursive: boolean,
  limits: SourceLimits,
  signal?: AbortSignal,
) {
  const body = await client.json(
    "/git/trees/" + gitSha(sha) + (recursive ? "?recursive=1" : ""),
    8 * 1024 * 1024,
    signal,
  );
  if (body.sha !== sha || typeof body.truncated !== "boolean" || !Array.isArray(body.tree))
    throw new SourceError("invalidSource");
  if (body.tree.length > limits.entries) throw new SourceError("sourceTooLarge");
  const entries = body.tree.map((value): GitTreeEntry => {
    const input = githubObject(value),
      path = sourcePath(input.path),
      id = gitSha(input.sha);
    if (!recursive && path.includes("/")) throw new SourceError("invalidSource");
    if (input.type === "tree" && input.mode === "040000") return { path, sha: id, kind: "directory", bytes: 0 };
    if (input.type === "commit" && input.mode === "160000") return { path, sha: id, kind: "gitlink", bytes: 0 };
    if (input.type === "blob" && input.mode === "120000")
      return { path, sha: id, kind: "symlink", bytes: Number.isSafeInteger(input.size) ? Number(input.size) : -1 };
    if (
      input.type !== "blob" ||
      !["100644", "100755"].includes(String(input.mode)) ||
      !Number.isSafeInteger(input.size) ||
      Number(input.size) < 0
    )
      throw new SourceError("invalidSource");
    return { path, sha: id, kind: "file", bytes: Number(input.size) };
  });
  return { entries, truncated: body.truncated };
}

export async function githubRootTree(
  client: GitHubSourceClient,
  sha: string,
  root: string,
  limits: SourceLimits,
  signal?: AbortSignal,
): Promise<string> {
  let current = gitSha(sha);
  for (const part of root ? root.split("/") : []) {
    const result = await tree(client, current, false, limits, signal);
    if (result.truncated) throw new SourceError("sourceInventoryIncomplete");
    const next = result.entries.find((entry) => entry.path === part);
    if (!next || next.kind !== "directory") throw new SourceError("sourceUnavailable");
    current = next.sha;
  }
  return current;
}

/** A truncated recursive result is discarded; complete bounded directory walks establish the inventory. */
export async function githubInventory(
  client: GitHubSourceClient,
  root: string,
  limits: SourceLimits,
  signal?: AbortSignal,
): Promise<readonly GitTreeEntry[]> {
  const result = await tree(client, root, true, limits, signal);
  let entries: GitTreeEntry[];
  if (!result.truncated) entries = result.entries;
  else {
    entries = [];
    const pending = [{ sha: root, path: "" }];
    for (let index = 0; index < pending.length; index++) {
      if (signal?.aborted) throw new SourceError("sourceCancelled");
      const current = pending[index]!,
        next = await tree(client, current.sha, false, limits, signal);
      if (next.truncated) throw new SourceError("sourceInventoryIncomplete");
      for (const child of next.entries) {
        if (entries.length >= limits.entries) throw new SourceError("sourceTooLarge");
        const path = sourcePath(current.path + child.path),
          entry = { ...child, path };
        entries.push(entry);
        if (entry.kind === "directory") pending.push({ sha: entry.sha, path: path + "/" });
      }
    }
  }
  const paths = new SourcePaths(limits.entries);
  let files = 0;
  for (const entry of entries) {
    paths.add(entry.path, entry.kind === "directory");
    if (entry.kind !== "directory" && ++files > limits.files) throw new SourceError("sourceTooLarge");
  }
  return Object.freeze(
    entries
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => Object.freeze({ ...entry })),
  );
}
