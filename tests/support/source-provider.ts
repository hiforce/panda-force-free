import { createHash } from "node:crypto";
import type { SourceHttpPort, SourceHttpRequest, SourceHttpResponse } from "../../src/server/packages/source-http.js";
import {
  PackageSourceProviders,
  type SourceCaptureProvider,
  type SourceCredentialResolver,
} from "../../src/server/packages/ingestion/providers.js";
import { PackageSourceIngestion, type SourceIngestionDiagnostic } from "../../src/server/packages/ingestion/service.js";
import { SourceRuntime, type SourceRuntimeLimits } from "../../src/server/packages/ingestion/runtime.js";
import type { sourceStageFixture } from "./source-staging.js";

const text = (value: string) => new TextEncoder().encode(value);
export function githubProviderFixture() {
  const content = text("<h1>Pinned provider source</h1>"),
    commit = "a".repeat(40),
    tree = "b".repeat(40),
    blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex"),
    calls: SourceHttpRequest[] = [];
  let denied = false;
  const json = (value: unknown): SourceHttpResponse => ({
    status: 200,
    headers: {},
    bytes: text(JSON.stringify(value)),
  });
  const http: SourceHttpPort = {
    async get(request) {
      calls.push(request);
      if (denied) return { status: 401, headers: {}, bytes: text("REMOTE_ERROR_MUST_NOT_PERSIST") };
      const url = new URL(request.url),
        path = url.pathname;
      if (url.origin !== "https://api.github.com") throw Error("Unexpected source authority");
      if (path === "/repos/example/themes")
        return json({ id: 42, full_name: "example/themes", default_branch: "main" });
      if (path === "/repos/example/themes/commits/main")
        return { status: 200, headers: {}, bytes: text(commit + "\n") };
      if (path === "/repos/example/themes/git/commits/" + commit) return json({ sha: commit, tree: { sha: tree } });
      if (path === "/repos/example/themes/git/trees/" + tree)
        return json({
          sha: tree,
          truncated: false,
          tree: [
            { path: "layout", type: "tree", mode: "040000", sha: "c".repeat(40) },
            { path: "layout/index.ejs", type: "blob", mode: "100644", sha: blob, size: content.length },
          ],
        });
      if (path === "/repos/example/themes/git/blobs/" + blob)
        return { status: 200, headers: {}, bytes: new Uint8Array(content) };
      return { status: 404, headers: {}, bytes: new Uint8Array() };
    },
  };
  return {
    http,
    calls,
    content,
    commit,
    deny() {
      denied = true;
    },
  };
}
export function sourceIngestionFixture(
  f: Awaited<ReturnType<typeof sourceStageFixture>>,
  options: {
    credentials?: SourceCredentialResolver;
    runtime?: SourceRuntimeLimits;
    provider?: SourceCaptureProvider;
  } = {},
) {
  const stages = { templates: f.service(undefined, 5000), skills: f.service(undefined, 5000, "skills") },
    github = githubProviderFixture(),
    diagnostics: SourceIngestionDiagnostic[] = [],
    real = new PackageSourceProviders(
      github.http,
      (actor, purpose, id, signal) => stages[purpose].original(actor, id, signal),
      options.credentials,
    ),
    runtime = new SourceRuntime(options.runtime),
    manager = new PackageSourceIngestion(stages, f.store, options.provider ?? real, runtime, f.now, (value) =>
      diagnostics.push(value),
    );
  return {
    stages,
    github,
    diagnostics,
    real,
    runtime,
    manager,
    async close() {
      manager.stop();
      await Promise.all([stages.templates.shutdown(), stages.skills.shutdown(), manager.drain()]);
    },
  };
}
