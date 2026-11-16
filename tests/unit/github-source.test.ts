import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { githubRepository, githubRef, githubSourceRequest } from "../../src/shared/packages/sources/github.js";
import { SourceError, DEFAULT_SOURCE_LIMITS } from "../../src/shared/packages/sources/contracts.js";
import { capturePackageSource } from "../../src/shared/packages/sources/reader.js";
import { GitHubPackageSources } from "../../src/server/packages/github/source.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import type { SourceHttpPort, SourceHttpRequest, SourceHttpResponse } from "../../src/server/packages/source-http.js";

const text = (value: string) => new TextEncoder().encode(value),
  commit = "a".repeat(40),
  root = "b".repeat(40),
  nested = "c".repeat(40),
  newer = "d".repeat(40);
const blob = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const json = (value: unknown): SourceHttpResponse => ({ status: 200, headers: {}, bytes: text(JSON.stringify(value)) });
function fixture() {
  const contents = new Map([
      ["LICENSE", text("Example license")],
      ["layout/index.ejs", text("<h1>Original template</h1>")],
    ]),
    objects = new Map([...contents].map(([path, bytes]) => [blob(bytes), bytes])),
    calls: SourceHttpRequest[] = [];
  const files = [...contents].map(([path, bytes]) => ({
    path,
    mode: "100644",
    type: "blob",
    size: bytes.length,
    sha: blob(bytes),
    url: "https://untrusted.invalid/ignored",
  }));
  let branch = commit,
    id = 123,
    recursiveTruncated = false,
    walkTruncated = false,
    corrupt = false,
    denied = 0;
  const http: SourceHttpPort = {
    async get(request) {
      calls.push({ ...request, headers: { ...request.headers } });
      if (request.signal?.aborted) throw new SourceError("sourceCancelled");
      const url = new URL(request.url),
        path = url.pathname.replace("/repos/example/templates", "");
      expect(url.origin).toBe("https://api.github.com");
      if (denied)
        return {
          status: denied,
          headers: denied === 429 ? { "x-ratelimit-remaining": "0" } : {},
          bytes: text("REMOTE_SECRET_MUST_NOT_ESCAPE"),
        };
      if (path === "") return json({ id, full_name: "example/templates", default_branch: "release/stable" });
      if (path === "/commits/release%2Fstable") return { status: 200, headers: {}, bytes: text(branch + "\n") };
      if (path === "/git/commits/" + commit) return json({ sha: commit, tree: { sha: root } });
      if (path === "/git/trees/" + root)
        return json({
          sha: root,
          truncated: url.search ? recursiveTruncated : walkTruncated,
          tree: url.search ? files : [files[0], { path: "layout", type: "tree", mode: "040000", sha: nested }],
        });
      if (path === "/git/trees/" + nested)
        return json({ sha: nested, truncated: false, tree: [{ ...files[1], path: "index.ejs" }] });
      const bytes = objects.get(path.replace("/git/blobs/", ""));
      if (bytes)
        return {
          status: 200,
          headers: {},
          bytes: corrupt ? new Uint8Array(bytes.length).fill(120) : new Uint8Array(bytes),
        };
      return { status: 404, headers: {}, bytes: text("missing") };
    },
  };
  return {
    http,
    calls,
    contents,
    files,
    objects,
    setBranch(value: string) {
      branch = value;
    },
    setId(value: number) {
      id = value;
    },
    truncate(recursive: boolean, walk = false) {
      recursiveTruncated = recursive;
      walkTruncated = walk;
    },
    corrupt() {
      corrupt = true;
    },
    deny(status: number) {
      denied = status;
    },
  };
}

test("GitHub inputs normalize repository addresses while separating refs and rejecting alternate authorities", () => {
  for (const value of [
    "example/templates",
    "https://github.com/example/templates.git",
    "git@github.com:example/templates.git",
  ])
    expect(githubRepository(value).url).toBe("https://github.com/example/templates");
  for (const value of [
    "http://github.com/example/templates",
    "https://github.com.evil/example/templates",
    "https://user:secret@github.com/example/templates",
    "https://github.com/example/templates/tree/main",
    "https://github.com/example/templates?token=secret",
    "https://github.com:444/example/templates",
    "https://github.com/../templates",
  ])
    expect(() => githubRepository(value), value).toThrow("invalidSource");
  for (const ref of ["../main", "main~1", "a//b", "a.lock", "a@{b", "bad\nref", "@"])
    expect(() => githubRef(ref), ref).toThrow("invalidSource");
  expect(githubRef("release/stable")).toBe("release/stable");
  expect(() => githubSourceRequest({ repository: "example/templates", token: "secret" })).toThrow("invalidSource");
});

test("GitHub sources freeze a resolved commit and fetch verified blobs only when selected", async () => {
  const f = fixture(),
    reader = await new GitHubPackageSources(f.http).open({ repository: "example/templates" });
  expect(reader.origin).toMatchObject({
    kind: "github",
    commit,
    tree: root,
    repositoryId: 123,
    requestedRef: "release/stable",
  });
  expect(f.calls.some((call) => call.url.includes("/git/blobs/"))).toBe(false);
  f.setBranch(newer);
  const selected = ["layout/index.ejs"],
    pending = capturePackageSource(reader, selected);
  selected[0] = "LICENSE";
  const captured = await pending;
  expect(captured.files.map((file) => file.path)).toEqual(["layout/index.ejs"]);
  expect(captured.text("layout/index.ejs")).toBe("<h1>Original template</h1>");
  expect(f.calls.filter((call) => call.url.includes("/git/blobs/")).length).toBe(1);
  expect(f.calls.every((call) => !call.headers.Authorization)).toBe(true);
  expect(f.calls.every((call) => call.headers["X-GitHub-Api-Version"] === "2026-03-10")).toBe(true);
  expect(Object.isFrozen(reader.files[0]!.integrity)).toBe(true);
});

test("pinned resumptions reject repository replacement and subdirectory reads avoid unrelated bodies", async () => {
  const f = fixture(),
    sources = new GitHubPackageSources(f.http),
    reader = await sources.open({ repository: "example/templates", ref: commit, root: "layout" }, undefined, 123);
  expect(f.calls.some((call) => call.url.includes("/commits/") && !call.url.includes("/git/commits/"))).toBe(false);
  expect(reader.origin).toMatchObject({ commit, tree: nested, root: "layout" });
  expect(reader.files.map((file) => file.path)).toEqual(["index.ejs"]);
  expect((await capturePackageSource(reader)).text("index.ejs")).toBe("<h1>Original template</h1>");
  f.setId(124);
  await expect(sources.open({ repository: "example/templates", ref: commit }, undefined, 123)).rejects.toThrow(
    "sourceChanged",
  );
});

test("truncated recursive inventories are replaced by complete walks and never silently omit files", async () => {
  const f = fixture();
  f.truncate(true);
  const reader = await new GitHubPackageSources(f.http).open({ repository: "example/templates", ref: commit });
  expect(reader.files.map((file) => file.path)).toEqual(["LICENSE", "layout/index.ejs"]);
  expect(f.calls.some((call) => call.url.endsWith("/git/trees/" + nested))).toBe(true);
  const broken = fixture();
  broken.truncate(true, true);
  await expect(
    new GitHubPackageSources(broken.http).open({ repository: "example/templates", ref: commit }),
  ).rejects.toThrow("sourceInventoryIncomplete");
});

test("GitHub blobs retain object identity, per-file budgets and current credential authorization", async () => {
  const f = fixture();
  let token: string | null = "source-test-token",
    grants = 0;
  const reader = await new GitHubPackageSources(f.http, {
    async token(id) {
      expect(id).toBe("account.one");
      grants++;
      return token;
    },
  }).open({ repository: "example/templates", ref: commit, connectionId: "account.one" });
  const before = grants;
  await reader.read("LICENSE");
  expect(grants).toBe(before + 1);
  const sent = f.calls.length;
  token = null;
  await expect(reader.read("LICENSE")).rejects.toThrow("sourceAccessDenied");
  expect(f.calls.length).toBe(sent);
  expect(JSON.stringify(reader.origin)).not.toContain("source-test-token");
  const invalid = fixture(),
    modified = await new GitHubPackageSources(invalid.http).open({ repository: "example/templates", ref: commit });
  invalid.corrupt();
  await expect(modified.read("LICENSE")).rejects.toThrow("sourceChanged");
  await expect(capturePackageSource(modified, ["LICENSE"], { ...DEFAULT_SOURCE_LIMITS, fileBytes: 2 })).rejects.toThrow(
    "sourceTooLarge",
  );
  const denied = fixture();
  denied.deny(429);
  await expect(new GitHubPackageSources(denied.http).open({ repository: "example/templates" })).rejects.toThrow(
    "sourceRateLimited",
  );
});

test("ZIP and GitHub selected sources produce the same resource identity and exact ZIP originals remain separate", async () => {
  const f = fixture(),
    github = await new GitHubPackageSources(f.http).open({ repository: "example/templates", ref: commit }),
    archive = zipSync(Object.fromEntries(f.contents));
  const pending = openZipSource(archive, "templates.zip");
  const original = new Uint8Array(archive);
  archive.fill(0);
  const uploaded = await pending;
  expect(uploaded.readArchive()).toEqual(original);
  uploaded.readArchive().fill(0);
  expect(uploaded.readArchive()).toEqual(original);
  expect((await capturePackageSource(uploaded)).digest).toBe((await capturePackageSource(github)).digest);
  const lying = { ...uploaded, read: async () => text("X".repeat(uploaded.files[0]!.bytes)) };
  await expect(capturePackageSource(lying, [uploaded.files[0]!.path])).rejects.toThrow("sourceChanged");
});

test("source cancellation does not resolve new refs or retrieve new blobs", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    new GitHubPackageSources(f.http).open({ repository: "example/templates" }, controller.signal),
  ).rejects.toThrow("sourceCancelled");
  expect(f.calls.length).toBe(0);
  const reader = await new GitHubPackageSources(f.http).open({ repository: "example/templates", ref: commit });
  await expect(reader.read("LICENSE", controller.signal)).rejects.toThrow("sourceCancelled");
  expect(f.calls.some((call) => call.url.includes("/git/blobs/"))).toBe(false);
});

test("cancelling the owning source scope aborts an active blob read even with a separate read signal", async () => {
  const f = fixture(),
    scope = new AbortController(),
    current = new AbortController();
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const http: SourceHttpPort = {
    get(request) {
      if (!request.url.includes("/git/blobs/")) return f.http.get(request);
      started();
      return new Promise((_resolve, reject) =>
        request.signal!.addEventListener("abort", () => reject(new SourceError("sourceCancelled")), { once: true }),
      );
    },
  };
  const reader = await new GitHubPackageSources(http).open(
    { repository: "example/templates", ref: commit },
    scope.signal,
  );
  const reading = reader.read("LICENSE", current.signal);
  await active;
  scope.abort();
  await expect(reading).rejects.toThrow("sourceCancelled");
  expect(current.signal.aborted).toBe(false);
});

test("unavailable Git entries remain explicit while selected regular files stay independently usable", async () => {
  const f = fixture();
  f.files.push({
    path: "private-link",
    mode: "120000",
    type: "blob",
    size: 10,
    sha: "e".repeat(40),
    url: "https://untrusted.invalid/never-read",
  });
  const reader = await new GitHubPackageSources(f.http).open({ repository: "example/templates", ref: commit });
  expect(reader.unavailable).toEqual([{ path: "private-link", reason: "symlink" }]);
  await expect(capturePackageSource(reader)).rejects.toThrow("unsupportedSourceEntry");
  expect((await capturePackageSource(reader, ["LICENSE"])).text("LICENSE")).toBe("Example license");
  await expect(reader.read("private-link")).rejects.toThrow("sourceUnavailable");
  const rejected = new GitHubPackageSources(f.http, {
    async token() {
      throw Error("CREDENTIAL_DETAILS_MUST_NOT_ESCAPE");
    },
  });
  try {
    await rejected.open({ repository: "example/templates", connectionId: "account.one" });
    throw Error("Expected credential rejection");
  } catch (error) {
    expect((error as Error).message).toBe("sourceAccessDenied");
  }
});
