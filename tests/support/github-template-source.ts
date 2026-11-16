import { createHash } from "node:crypto";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import type { SourceHttpPort, SourceHttpRequest, SourceHttpResponse } from "../../src/server/packages/source-http.js";

/** A fixed repository API shape with real Git blob identities and complete template bytes. */
export async function githubTemplateSource(archive: Uint8Array) {
  const reader = await openZipSource(archive, "source.zip"),
    commit = "a".repeat(40),
    tree = "b".repeat(40),
    blobs = new Map<string, Uint8Array>(),
    entries: object[] = [],
    dirs = new Set<string>(),
    calls: SourceHttpRequest[] = [];
  for (const file of reader.files) {
    const bytes = await reader.read(file.path),
      sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    blobs.set(sha, bytes);
    entries.push({ path: file.path, type: "blob", mode: "100644", sha, size: bytes.length });
  }
  for (const path of dirs)
    entries.push({ path, type: "tree", mode: "040000", sha: createHash("sha1").update(path).digest("hex") });
  const text = (value: string) => new TextEncoder().encode(value),
    json = (value: unknown): SourceHttpResponse => ({ status: 200, headers: {}, bytes: text(JSON.stringify(value)) });
  const http: SourceHttpPort = {
    async get(request) {
      calls.push(request);
      const url = new URL(request.url),
        base = "/repos/example/templates";
      if (url.origin !== "https://api.github.com") throw Error("Unexpected provider authority");
      if (url.pathname === base) return json({ id: 42, full_name: "example/templates", default_branch: "main" });
      if (url.pathname === base + "/commits/main") return { status: 200, headers: {}, bytes: text(commit + "\n") };
      if (url.pathname === base + "/git/commits/" + commit) return json({ sha: commit, tree: { sha: tree } });
      if (url.pathname === base + "/git/trees/" + tree) return json({ sha: tree, truncated: false, tree: entries });
      const sha = url.pathname.slice((base + "/git/blobs/").length),
        bytes = blobs.get(sha);
      if (url.pathname.startsWith(base + "/git/blobs/") && bytes)
        return { status: 200, headers: {}, bytes: new Uint8Array(bytes) };
      return { status: 404, headers: {}, bytes: new Uint8Array() };
    },
  };
  return { http, commit, tree, calls };
}
