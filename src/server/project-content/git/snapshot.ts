import { PROJECT_CONTENT_LIMITS } from "../limits.js";
import type { OwnedProjectDirectory } from "../owned-directory.js";
import type { ContentAuthor } from "./process.js";
import { projectGit } from "./process.js";
import { ProjectContentError } from "../errors.js";
import { projectFilePath } from "../paths.js";

export type ProjectFileEntry = { path: string; blob: string };
export type ProjectFileChange = { path: string; content: Uint8Array | string | null };
const contentRef = "refs/heads/content";
const objectId = (value: string) => {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new ProjectContentError("invalidFile");
  return value;
};

/** Plumbing never reads the working index, runs add/checkout, or scans unrelated disk contents. */
export class ProjectGitSnapshots {
  constructor(private readonly owned: OwnedProjectDirectory) {}

  private async run(args: readonly string[], options?: Parameters<typeof projectGit>[2]): Promise<Buffer> {
    await this.owned.verify();
    return projectGit(this.owned.directory, args, options);
  }

  async head(): Promise<string> {
    return objectId((await this.run(["rev-parse", "--verify", contentRef])).toString().trim());
  }
  async parent(commit: string): Promise<string> {
    return objectId((await this.run(["rev-parse", "--verify", objectId(commit) + "^"])).toString().trim());
  }

  async entries(commit: string): Promise<ProjectFileEntry[]> {
    const buffer = await this.run(["ls-tree", "-rz", "--full-tree", objectId(commit)], {
      bytes: 4 * 1024 * 1024,
    });
    const rows = buffer.toString("utf8").split("\0").filter(Boolean);
    if (rows.length > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
    return rows.map((row) => {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(row);
      if (!match) throw new ProjectContentError("invalidFile");
      return { blob: match[1]!, path: projectFilePath(match[2]!) };
    });
  }

  async content(blob: string, bytes = PROJECT_CONTENT_LIMITS.fileBytes): Promise<Buffer> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > PROJECT_CONTENT_LIMITS.fileBytes)
      throw new ProjectContentError("invalidFile");
    return this.run(["cat-file", "blob", objectId(blob)], { bytes });
  }

  async fileAt(commit: string, path: string, bytes = PROJECT_CONTENT_LIMITS.fileBytes): Promise<Buffer | null> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > PROJECT_CONTENT_LIMITS.fileBytes)
      throw new ProjectContentError("invalidFile");
    projectFilePath(path);
    const row = (await this.run(["ls-tree", "-z", objectId(commit), "--", path], { bytes: 4096 })).toString("utf8");
    if (!row) return null;
    const match = /^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(row);
    if (!match || match[2] !== path) throw new ProjectContentError("invalidFile");
    return this.content(match[1]!, bytes);
  }

  async prepare(
    base: string,
    changes: readonly ProjectFileChange[],
    author: ContentAuthor,
    message: string,
  ): Promise<{ commit: string; entries: ProjectFileEntry[]; changed: boolean }> {
    const previous = await this.entries(objectId(base)),
      next = new Map(previous.map((row) => [row.path, row.blob]));
    const seen = new Set<string>();
    for (const change of changes) {
      const path = projectFilePath(change.path);
      if (seen.has(path)) throw new ProjectContentError("invalidFile");
      seen.add(path);
      if (change.content === null) next.delete(path);
      else {
        if (Buffer.byteLength(change.content) > PROJECT_CONTENT_LIMITS.fileBytes)
          throw new ProjectContentError("invalidFile");
        const hash = objectId(
          (
            await this.run(["hash-object", "-w", "--stdin", "--no-filters"], {
              input: change.content,
            })
          )
            .toString()
            .trim(),
        );
        next.set(path, hash);
      }
    }
    if (next.size > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
    const entries = [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, blob]) => ({ path, blob }));
    if (previous.length === entries.length && previous.every((row) => next.get(row.path) === row.blob))
      return { commit: base, entries, changed: false };
    const root = new Map<string, Map<string, string> | string>();
    for (const entry of entries) {
      const parts = entry.path.split("/");
      if (parts.length === 1) root.set(entry.path, entry.blob);
      else {
        let children = root.get(parts[0]!) as Map<string, string> | undefined;
        if (!children) {
          children = new Map();
          root.set(parts[0]!, children);
        }
        children.set(parts[1]!, entry.blob);
      }
    }
    const treeRows: string[] = [];
    for (const [name, item] of root) {
      const blob =
        typeof item === "string"
          ? item
          : await this.tree([...item].map(([name, blob]) => `100644 blob ${blob}\t${name}\0`));
      treeRows.push(`${typeof item === "string" ? "100644 blob" : "040000 tree"} ${blob}\t${name}\0`);
    }
    const tree = await this.tree(treeRows);
    if (!message || message.includes("\0") || Buffer.byteLength(message) > 16384)
      throw new ProjectContentError("invalidFile");
    const commit = objectId(
      (await this.run(["commit-tree", tree, "-p", base], { input: message + "\n", identity: author }))
        .toString()
        .trim(),
    );
    return { commit, entries, changed: true };
  }

  async publish(base: string, commit: string): Promise<void> {
    try {
      await this.run(["update-ref", contentRef, objectId(commit), objectId(base)]);
    } catch (error) {
      if ((await this.head()) !== base) throw new ProjectContentError("conflict");
      throw error;
    }
  }

  private async tree(rows: string[]): Promise<string> {
    return objectId((await this.run(["mktree", "-z"], { input: rows.join("") })).toString().trim());
  }
}
