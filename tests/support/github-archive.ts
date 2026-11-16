import { createHash } from "node:crypto";
import { zipSync, type Zippable } from "fflate";
import type { SourceHttpPort, SourceHttpRequest, SourceHttpResponse } from "../../src/server/packages/source-http.js";

export const archiveCommit = "a".repeat(40);
const tree = "b".repeat(40),
  subtree = "c".repeat(40);
export const gitBlob = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);
const json = (value: unknown): SourceHttpResponse => ({ status: 200, headers: {}, bytes: text(JSON.stringify(value)) });

/** Real ZIP records and Git identities let tests independently corrupt the archive projection. */
export function githubArchiveFixture(root = "") {
  const contents = new Map(
      Array.from({ length: 24 }, (_, i) => [`layout/page-${i}.ejs`, text("<h1>Original " + i + "</h1>")]),
    ),
    calls: SourceHttpRequest[] = [];
  let location =
      "https://codeload.github.com/example/themes/legacy.zip/" + archiveCommit + "?token=TEST_DOWNLOAD_QUERY",
    archiveStatus = 200,
    token: string | null = "TEST_SELECTED_CONNECTION",
    afterLocation = () => {},
    beforeArchive = () => {};
  let quota: number | undefined, reset: number | undefined, rawArchive: Uint8Array | undefined;
  const links: string[] = [],
    linkTargets = new Map<string, Uint8Array>(),
    archived = new Map(contents),
    extras: Zippable = {};
  function archive() {
    return zipSync({
      ...Object.fromEntries(
        [...archived].map(([path, bytes]) => ["snapshot/" + (root ? root + "/" : "") + path, bytes]),
      ),
      ...Object.fromEntries(
        [...linkTargets].map(([path, bytes]) => [
          "snapshot/" + (root ? root + "/" : "") + path,
          [bytes, { os: 3, attrs: 0xa1ff0000 }],
        ]),
      ),
      ...extras,
    });
  }
  const http: SourceHttpPort = {
    async get(request) {
      calls.push({ ...request, headers: { ...request.headers } });
      if (request.signal?.aborted) throw new Error("Unexpected cancelled request");
      const url = new URL(request.url),
        base = "/repos/example/themes";
      if (url.origin === "https://codeload.github.com") {
        beforeArchive();
        return {
          status: archiveStatus,
          headers: archiveStatus === 302 ? { location: "https://untrusted.invalid/never" } : {},
          bytes: rawArchive ?? archive(),
        };
      }
      if (url.origin !== "https://api.github.com") throw new Error("Unexpected authority");
      if (url.pathname === base) return json({ id: 42, full_name: "example/themes", default_branch: "main" });
      if (url.pathname === base + "/commits/main") return { status: 200, headers: {}, bytes: text(archiveCommit) };
      if (url.pathname === base + "/git/commits/" + archiveCommit)
        return json({ sha: archiveCommit, tree: { sha: tree } });
      if (root && url.pathname === base + "/git/trees/" + tree)
        return json({
          sha: tree,
          truncated: false,
          tree: [{ path: root, type: "tree", mode: "040000", sha: subtree }],
        });
      if (url.pathname === base + "/git/trees/" + (root ? subtree : tree))
        return json({
          sha: root ? subtree : tree,
          truncated: false,
          tree: [...contents]
            .map(([path, bytes]) => ({
              path,
              type: "blob",
              mode: "100644",
              sha: gitBlob(bytes),
              size: bytes.length,
            }))
            .concat(links.map((path) => ({ path, type: "blob", mode: "120000", sha: "d".repeat(40), size: 12 })))
            .concat(
              [...linkTargets].map(([path, bytes]) => ({
                path,
                type: "blob",
                mode: "120000",
                sha: gitBlob(bytes),
                size: bytes.length,
              })),
            ),
        });
      if (url.pathname === base + "/zipball/" + archiveCommit) {
        afterLocation();
        return {
          status: 302,
          headers: {
            location,
            ...(quota === undefined ? {} : { "x-ratelimit-remaining": String(quota) }),
            ...(reset === undefined ? {} : { "x-ratelimit-reset": String(reset) }),
          },
          bytes: new Uint8Array(),
        };
      }
      for (const bytes of [...contents.values(), ...linkTargets.values()])
        if (url.pathname === base + "/git/blobs/" + gitBlob(bytes))
          return { status: 200, headers: {}, bytes: new Uint8Array(bytes) };
      return { status: 404, headers: {}, bytes: new Uint8Array() };
    },
  };
  return {
    http,
    calls,
    contents,
    links,
    linkTargets,
    archived,
    extras,
    archive,
    credentials: {
      async token() {
        return token;
      },
    },
    redirect(value: string) {
      location = value;
    },
    status(value: number) {
      archiveStatus = value;
    },
    rawArchive(value: Uint8Array) {
      rawArchive = new Uint8Array(value);
    },
    quota(value: number, expires?: number) {
      quota = value;
      reset = expires;
    },
    revoke() {
      token = null;
    },
    afterLocation(value: () => void) {
      afterLocation = value;
    },
    beforeArchive(value: () => void) {
      beforeArchive = value;
    },
    request: { repository: "example/themes", root, connectionId: "chosen-connection" },
  };
}
