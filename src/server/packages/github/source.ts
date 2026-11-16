import {
  SourceError,
  sourceLimits,
  type SourceLimits,
  type SourceEntryPolicy,
} from "../../../shared/packages/sources/contracts.js";
import { githubRepository, githubRef, githubSourceRequest } from "../../../shared/packages/sources/github.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";
import {
  gitBlobDigest,
  selectSourceFiles,
  type PackageSourceFile,
  type PackageSourceReader,
} from "../../../shared/packages/sources/reader.js";
import type { SourceHttpPort } from "../source-http.js";
import { GitHubSourceClient, githubObject, gitSha, type GitHubSourceCredentials } from "./client.js";
import { githubInventory, githubRootTree } from "./inventory.js";
import { sourceDeadline } from "../source-deadline.js";
import { captureSourceSnapshot } from "../../../shared/packages/sources/snapshot.js";
import { captureLinkedSourceSnapshot } from "../../../shared/packages/sources/linked-capture.js";
import { downloadGitHubArchive } from "./archive.js";
import { githubArchiveReader } from "./archive-reader.js";

export class GitHubPackageSources {
  private limits: SourceLimits;
  constructor(
    private http: SourceHttpPort,
    private credentials?: GitHubSourceCredentials,
    options?: SourceLimits,
  ) {
    this.limits = sourceLimits(options);
  }
  /** Small selections remain lazy; complete libraries use one pinned archive instead of one API call per file. */
  async capture(
    value: unknown,
    selection?: readonly string[],
    signal?: AbortSignal,
    expectedRepositoryId?: number,
    policy: SourceEntryPolicy = "regular-only/v1",
  ) {
    const selected = selection && [...selection],
      request = githubSourceRequest(value),
      reader = await this.open(value, signal, expectedRepositoryId, policy),
      files = selectSourceFiles(
        reader.links?.length
          ? {
              ...reader,
              files: [...reader.files, ...reader.links],
              unavailable: reader.unavailable.filter((entry) => entry.reason !== "symlink"),
            }
          : reader,
        selected,
        this.limits,
      ),
      capture = policy === "logical-links/v2" ? captureLinkedSourceSnapshot : captureSourceSnapshot;
    if (files.length <= 16) return capture(reader, selected, undefined, this.limits, signal);
    if (reader.origin.kind !== "github") throw new SourceError("invalidSource");
    const client = new GitHubSourceClient(this.http, request.repository, request.connectionId, this.credentials);
    let bulk: PackageSourceReader;
    try {
      const bytes = await downloadGitHubArchive(this.http, client, reader.origin.commit, this.limits, signal);
      bulk = await githubArchiveReader(reader, files, bytes, this.limits, signal, (count) =>
        client.requireRequests(count),
      );
    } catch (error) {
      if (signal?.aborted) throw new SourceError("sourceCancelled");
      if (
        !(error instanceof SourceError) ||
        ![
          "sourceTooLarge",
          "unsupportedArchive",
          "invalidArchive",
          "invalidSourcePath",
          "duplicateSourcePath",
          "sourceChanged",
          "sourceUnavailable",
          "sourceTimedOut",
        ].includes(error.code)
      )
        throw error;
      client.requireRequests(files.length);
      bulk = reader;
    }
    return capture(bulk, selected, undefined, this.limits, signal);
  }
  async open(
    value: unknown,
    signal?: AbortSignal,
    expectedRepositoryId?: number,
    policy: SourceEntryPolicy = "regular-only/v1",
  ): Promise<PackageSourceReader> {
    const deadline = sourceDeadline(signal, 60000);
    try {
      return await this.acquire(value, deadline.signal, signal, expectedRepositoryId, policy);
    } catch (error) {
      throw deadline.error(error);
    } finally {
      deadline.close();
    }
  }
  private async acquire(
    value: unknown,
    opening: AbortSignal,
    signal?: AbortSignal,
    expectedRepositoryId?: number,
    policy: SourceEntryPolicy = "regular-only/v1",
  ): Promise<PackageSourceReader> {
    const request = githubSourceRequest(value),
      client = new GitHubSourceClient(this.http, request.repository, request.connectionId, this.credentials);
    const repository = await client.json("", 256 * 1024, opening),
      canonical = githubRepository(repository.full_name);
    if (
      canonical.url.toLowerCase() !== request.repository.url.toLowerCase() ||
      !Number.isSafeInteger(repository.id) ||
      Number(repository.id) <= 0
    )
      throw new SourceError("invalidSource");
    if (expectedRepositoryId !== undefined && repository.id !== expectedRepositoryId)
      throw new SourceError("sourceChanged");
    const ref = request.ref || githubRef(repository.default_branch),
      commit = /^[a-f0-9]{40}$/.test(ref) ? ref : await client.resolve(ref, opening),
      object = await client.json("/git/commits/" + commit, 256 * 1024, opening);
    if (object.sha !== commit) throw new SourceError("sourceChanged");
    const root = await githubRootTree(
        client,
        gitSha(githubObject(object.tree).sha),
        request.root,
        this.limits,
        opening,
      ),
      entries = await githubInventory(client, root, this.limits, opening),
      files = new Map<string, PackageSourceFile>(),
      links = new Map<string, PackageSourceFile>();
    for (const entry of entries)
      if (entry.kind === "file" || (entry.kind === "symlink" && policy === "logical-links/v2")) {
        if (entry.bytes < 0) throw new SourceError("invalidSource");
        (entry.kind === "file" ? files : links).set(
          entry.path,
          Object.freeze({
            path: entry.path,
            bytes: entry.bytes,
            integrity: Object.freeze({ algorithm: "git-blob-sha1" as const, value: entry.sha }),
          }),
        );
      }
    const origin = Object.freeze({
      kind: "github" as const,
      repository: canonical.url,
      repositoryId: Number(repository.id),
      requestedRef: ref,
      commit,
      tree: root,
      root: request.root,
    });
    return Object.freeze({
      origin,
      files: Object.freeze([...files.values()]),
      ...(policy === "logical-links/v2" ? { links: Object.freeze([...links.values()]) } : {}),
      unavailable: Object.freeze(
        entries
          .filter((entry) => entry.kind === "symlink" || entry.kind === "gitlink")
          .map((entry) => Object.freeze({ path: entry.path, reason: entry.kind as "symlink" | "gitlink" })),
      ),
      read: async (path: string, current?: AbortSignal) => {
        if (current?.aborted || signal?.aborted) throw new SourceError("sourceCancelled");
        const file = files.get(sourcePath(path)) ?? links.get(sourcePath(path));
        if (!file) throw new SourceError("sourceUnavailable");
        if (file.bytes > this.limits.fileBytes) throw new SourceError("sourceTooLarge");
        const active = current && signal ? AbortSignal.any([current, signal]) : current || signal;
        const bytes = await client.bytes("/git/blobs/" + file.integrity.value, Math.max(1, file.bytes), active);
        if (bytes.byteLength !== file.bytes || (await gitBlobDigest(bytes)) !== file.integrity.value)
          throw new SourceError("sourceChanged");
        if (current?.aborted || signal?.aborted) throw new SourceError("sourceCancelled");
        return new Uint8Array(bytes);
      },
    });
  }
}
