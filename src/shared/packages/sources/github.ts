import { SourceError } from "./contracts.js";
import { sourcePath } from "./paths.js";

export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
  readonly url: string;
}
export interface GitHubSourceRequest {
  readonly repository: GitHubRepository;
  readonly ref?: string;
  readonly root: string;
  readonly connectionId?: string;
}

export function githubRepository(value: unknown): GitHubRepository {
  if (typeof value !== "string" || value.length > 512) throw new SourceError("invalidSource");
  let address = value.trim();
  if (address.startsWith("git@github.com:")) address = "https://github.com/" + address.slice(15);
  if (!address.includes("://")) address = "https://github.com/" + address;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new SourceError("invalidSource");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new SourceError("invalidSource");
  const parts = url.pathname.replace(/\/$/, "").split("/");
  if (parts.length !== 3 || parts[0] !== "") throw new SourceError("invalidSource");
  const owner = parts[1]!,
    name = parts[2]!.replace(/\.git$/i, "");
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner) ||
    !/^[a-z0-9_.-]{1,100}$/i.test(name) ||
    [".", ".."].includes(name)
  )
    throw new SourceError("invalidSource");
  return Object.freeze({ owner, name, url: `https://github.com/${owner}/${name}` });
}
export function githubRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    /[\p{Cc}\p{Cf}\p{Cs}\s~^:?*[\\]/u.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value === "@" ||
    value.endsWith(".") ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new SourceError("invalidSource");
  return value;
}
export function githubSourceRequest(value: unknown): GitHubSourceRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["repository", "ref", "root", "connectionId"].includes(key))
  )
    throw new SourceError("invalidSource");
  const input = value as Record<string, unknown>,
    repository = githubRepository(input.repository);
  const root = input.root === undefined || input.root === "" ? "" : sourcePath(input.root);
  if (
    input.connectionId !== undefined &&
    (typeof input.connectionId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(input.connectionId))
  )
    throw new SourceError("invalidSource");
  return Object.freeze({
    repository,
    root,
    ...(input.ref === undefined ? {} : { ref: githubRef(input.ref) }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId as string }),
  });
}
