import { ProjectContentError } from "../errors.js";
import type { OwnedProjectDirectory } from "../owned-directory.js";
import { projectFilePath } from "../paths.js";
import { projectGit } from "./process.js";

export interface ContentHistoryRecord {
  commit: string;
  message: string;
}

/** Internal callers supply closed trailer patterns; every query is path-scoped and output-bounded. */
export async function readContentHistory(
  owned: OwnedProjectDirectory,
  input: { path: string; patterns: readonly string[]; limit: number; commit?: string },
): Promise<ContentHistoryRecord[]> {
  const { path, limit, commit } = input,
    patterns = [...input.patterns];
  projectFilePath(path);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !patterns.length ||
    patterns.length > 8 ||
    patterns.some((value) => !value || value.includes("\0") || value.length > 512) ||
    (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit))
  )
    throw new ProjectContentError("invalidFile");
  await owned.verify();
  const bytes = await projectGit(
    owned.directory,
    [
      "log",
      "--no-renames",
      "--format=%H%x00%B%x00",
      "--max-count=" + limit,
      "--extended-regexp",
      "--all-match",
      ...patterns.map((pattern) => "--grep=" + pattern),
      commit ?? "refs/heads/content",
      "--",
      path,
    ],
    { bytes: 8 * 1024 * 1024 },
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectContentError("invalidFile");
  }
  const parts = text.split("\0"),
    result: ContentHistoryRecord[] = [];
  if (parts.pop()?.trim() || parts.length % 2) throw new ProjectContentError("invalidFile");
  for (let index = 0; index < parts.length; index += 2) {
    const commit = parts[index]!.trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new ProjectContentError("invalidFile");
    result.push({ commit, message: parts[index + 1]! });
  }
  return result;
}
