import { expect, test } from "bun:test";
import { githubArchiveFixture, archiveCommit } from "../support/github-archive.js";
import { GitHubPackageSources } from "../../src/server/packages/github/source.js";
import { DEFAULT_SOURCE_LIMITS, SourceError } from "../../src/shared/packages/sources/contracts.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { projectSourceAliases } from "../../src/shared/packages/sources/aliases.js";

test("complete GitHub sources use a fixed commit archive and retain every verified original without per-file API reads", async () => {
  const f = githubArchiveFixture(),
    source = await new GitHubPackageSources(f.http, f.credentials).capture(f.request);
  expect(source.tree.files.map((f) => f.path)).toEqual([...f.contents.keys()].sort());
  for (const [path, bytes] of f.contents) expect(source.tree.read(path)).toEqual(bytes);
  expect(f.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(0);
  expect(f.calls).toHaveLength(6);
  expect(f.calls.find((call) => call.url.includes("/zipball/"))!.url).toEndWith(archiveCommit);
  const download = f.calls.find((call) => call.url.startsWith("https://codeload.github.com"))!;
  expect(download.headers.Authorization).toBeUndefined();
  expect(
    f.calls
      .filter((call) => call.url.startsWith("https://api.github.com"))
      .every((call) => call.headers.Authorization === "Bearer TEST_SELECTED_CONNECTION"),
  ).toBe(true);
  expect(JSON.stringify(source.descriptor)).not.toMatch(/TEST_DOWNLOAD_QUERY|TEST_SELECTED_CONNECTION|connectionId/);
  expect(source.readArchive()).toBeUndefined();
});

test("linked GitHub acquisition verifies raw link blobs in archives and direct reads without silently resolving them", async () => {
  const f = githubArchiveFixture("theme");
  f.linkTargets.set("alias.ejs", new TextEncoder().encode("layout/page-0.ejs"));
  const provider = new GitHubPackageSources(f.http, f.credentials),
    source = await provider.capture(f.request, undefined, undefined, 42, "logical-links/v2");
  expect(source.links!.text("alias.ejs")).toBe("layout/page-0.ejs");
  expect(source.tree.has("alias.ejs")).toBe(false);
  expect((await projectSourceAliases(source)).tree.text("alias.ejs")).toBe("<h1>Original 0</h1>");
  expect(f.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(0);
  const direct = await provider.capture(f.request, ["alias.ejs"], undefined, 42, "logical-links/v2");
  expect(direct.links!.text("alias.ejs")).toBe("layout/page-0.ejs");
  expect(direct.tree.files).toHaveLength(0);
  await expect(provider.capture(f.request)).rejects.toThrow("unsupportedSourceEntry");
  f.extras["snapshot/theme/alias.ejs"] = [new TextEncoder().encode("layout/page-1.ejs"), { os: 3, attrs: 0xa1ff0000 }];
  const recovered = await provider.capture(f.request, undefined, undefined, 42, "logical-links/v2");
  expect(recovered.links!.text("alias.ejs")).toBe("layout/page-0.ejs");
  expect(f.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(2);
});

test("small and empty selections retain lazy Git reads while archive selections are detached before asynchronous acquisition", async () => {
  const small = githubArchiveFixture(),
    empty = githubArchiveFixture();
  const source = await new GitHubPackageSources(small.http, small.credentials).capture(small.request, [
    "layout/page-0.ejs",
  ]);
  expect(source.tree.files).toHaveLength(1);
  expect(small.calls.some((call) => /zipball|codeload/.test(call.url))).toBe(false);
  expect(
    (await new GitHubPackageSources(empty.http, empty.credentials).capture(empty.request, [])).tree.files,
  ).toHaveLength(0);
  expect(empty.calls.some((call) => /zipball|codeload|blobs/.test(call.url))).toBe(false);
  const f = githubArchiveFixture(),
    selected = [...f.contents.keys()],
    pending = new GitHubPackageSources(f.http, f.credentials).capture(f.request, selected);
  selected.length = 0;
  expect((await pending).tree.files).toHaveLength(24);
});

test("subdirectory archives omit unrelated files and symbolic links without weakening normal ZIP intake", async () => {
  const f = githubArchiveFixture("theme");
  f.extras["snapshot/unrelated.txt"] = new TextEncoder().encode("Not selected");
  f.extras["snapshot/link"] = [new TextEncoder().encode("/etc/passwd"), { attrs: 0xa000 << 16 }];
  const source = await new GitHubPackageSources(f.http, f.credentials).capture(f.request);
  expect(source.tree.files).toHaveLength(24);
  expect(source.descriptor.origin).toMatchObject({ root: "theme", commit: archiveCommit });
  expect(source.tree.files.some((file) => /link|unrelated/.test(file.path))).toBe(false);
  await expect(openZipSource(f.archive(), "ordinary.zip")).rejects.toThrow("unsupportedArchive");
});

test("export-ignore and export-subst projections recover a bounded number of exact Git blobs", async () => {
  const f = githubArchiveFixture();
  f.archived.delete("layout/page-0.ejs");
  f.archived.set("layout/page-1.ejs", new TextEncoder().encode("Substituted archive metadata"));
  const source = await new GitHubPackageSources(f.http, f.credentials).capture(f.request);
  expect(source.tree.read("layout/page-0.ejs")).toEqual(f.contents.get("layout/page-0.ejs")!);
  expect(source.tree.read("layout/page-1.ejs")).toEqual(f.contents.get("layout/page-1.ejs")!);
  expect(f.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(2);
  const changed = githubArchiveFixture();
  changed.archived.clear();
  changed.extras["snapshot/unrelated"] = new Uint8Array();
  expect(
    (await new GitHubPackageSources(changed.http, changed.credentials).capture(changed.request)).tree.files,
  ).toHaveLength(24);
  expect(changed.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(24);
});

test("linked entries remain explicit and full capture cannot silently drop language aliases", async () => {
  const f = githubArchiveFixture();
  f.links.push("languages/default.yml");
  f.extras["snapshot/languages/default.yml"] = [new TextEncoder().encode("en.yml"), { attrs: 0xa000 << 16 }];
  const provider = new GitHubPackageSources(f.http, f.credentials);
  await expect(provider.capture(f.request)).rejects.toThrow("unsupportedSourceEntry");
  expect(f.calls.some((call) => /zipball|codeload/.test(call.url))).toBe(false);
  const source = await provider.capture(f.request, [...f.contents.keys()]);
  expect(source.descriptor.inventory.unavailable).toEqual([{ path: "languages/default.yml", reason: "symlink" }]);
  expect(source.tree.files).toHaveLength(24);
});

test("archive limits retain the original blob path and revoked fallback reads cannot return incomplete sources", async () => {
  const f = githubArchiveFixture();
  expect(
    (
      await new GitHubPackageSources(f.http, f.credentials, { ...DEFAULT_SOURCE_LIMITS, archiveBytes: 32 }).capture(
        f.request,
      )
    ).tree.files,
  ).toHaveLength(24);
  expect(f.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(24);
  const denied = githubArchiveFixture();
  denied.archived.delete("layout/page-0.ejs");
  denied.beforeArchive(() => denied.revoke());
  await expect(new GitHubPackageSources(denied.http, denied.credentials).capture(denied.request)).rejects.toThrow(
    "sourceAccessDenied",
  );
  expect(denied.calls.some((call) => call.url.includes("/git/blobs/"))).toBe(false);
});

test("archive fallback checks available API requests without retaining expired quota estimates", async () => {
  const exhausted = githubArchiveFixture();
  exhausted.archived.delete("layout/page-0.ejs");
  exhausted.quota(0, Math.floor(Date.now() / 1000) + 60);
  await expect(
    new GitHubPackageSources(exhausted.http, exhausted.credentials).capture(exhausted.request),
  ).rejects.toThrow("sourceRateLimited");
  expect(exhausted.calls.some((call) => call.url.includes("/git/blobs/"))).toBe(false);
  const expired = githubArchiveFixture();
  expired.archived.delete("layout/page-0.ejs");
  expired.quota(0, 1);
  expect(
    (await new GitHubPackageSources(expired.http, expired.credentials).capture(expired.request)).tree.files,
  ).toHaveLength(24);
  const all = githubArchiveFixture();
  all.quota(0);
  expect((await new GitHubPackageSources(all.http, all.credentials).capture(all.request)).tree.files).toHaveLength(24);
});

test("archive redirects cannot change repository, commit, authority or forward selected connection credentials", async () => {
  for (const redirect of [
    "https://untrusted.invalid/example/themes/legacy.zip/" + archiveCommit,
    "https://codeload.github.com/other/themes/legacy.zip/" + archiveCommit,
    "https://codeload.github.com/example/themes/legacy.zip/main",
    "https://user:secret@codeload.github.com/example/themes/legacy.zip/" + archiveCommit,
    "https://codeload.github.com:444/example/themes/legacy.zip/" + archiveCommit,
  ]) {
    const f = githubArchiveFixture();
    f.redirect(redirect);
    await expect(new GitHubPackageSources(f.http, f.credentials).capture(f.request)).rejects.toThrow("invalidSource");
    expect(f.calls.some((call) => call.url.startsWith("https://codeload.github.com"))).toBe(false);
  }
  const f = githubArchiveFixture();
  f.status(302);
  expect((await new GitHubPackageSources(f.http, f.credentials).capture(f.request)).tree.files).toHaveLength(24);
  expect(f.calls.some((call) => call.url.startsWith("https://untrusted.invalid"))).toBe(false);
});

test("archive host failures preserve direct verified reads without overriding cancellation or authentication failures", async () => {
  for (const code of ["sourceUnavailable", "sourceTimedOut"] as const) {
    const f = githubArchiveFixture();
    f.beforeArchive(() => {
      throw new SourceError(code);
    });
    expect((await new GitHubPackageSources(f.http, f.credentials).capture(f.request)).tree.files).toHaveLength(24);
    expect(f.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(24);
  }
});

test("invalid archive projections cannot add paths or replace the independently verified Git source", async () => {
  const blocked = githubArchiveFixture();
  blocked.rawArchive(new TextEncoder().encode("<html>Archive host blocked</html>"));
  const recovered = await new GitHubPackageSources(blocked.http, blocked.credentials).capture(blocked.request);
  expect(recovered.tree.files).toHaveLength(24);
  expect(recovered.tree.read("layout/page-0.ejs")).toEqual(blocked.contents.get("layout/page-0.ejs")!);
  const unsafe = githubArchiveFixture();
  unsafe.extras["snapshot/../escape"] = new TextEncoder().encode("Untrusted archive content");
  await expect(openZipSource(unsafe.archive(), "uploaded.zip")).rejects.toThrow("invalidSourcePath");
  const original = await new GitHubPackageSources(unsafe.http, unsafe.credentials).capture(unsafe.request);
  expect(original.tree.files).toHaveLength(24);
  expect(original.tree.files.some((file) => file.path.includes("escape"))).toBe(false);
  expect(unsafe.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(24);
});

test("revocation between archive requests and cancellation after download prevent publication of captured bytes", async () => {
  const denied = githubArchiveFixture();
  denied.afterLocation(() => denied.revoke());
  await expect(new GitHubPackageSources(denied.http, denied.credentials).capture(denied.request)).rejects.toThrow(
    "sourceAccessDenied",
  );
  expect(denied.calls.some((call) => call.url.startsWith("https://codeload.github.com"))).toBe(false);
  const f = githubArchiveFixture(),
    controller = new AbortController();
  f.beforeArchive(() => controller.abort());
  await expect(
    new GitHubPackageSources(f.http, f.credentials).capture(f.request, undefined, controller.signal),
  ).rejects.toThrow("sourceCancelled");
  const bounded = githubArchiveFixture();
  await expect(
    new GitHubPackageSources(bounded.http, bounded.credentials, { ...DEFAULT_SOURCE_LIMITS, fileBytes: 2 }).capture(
      bounded.request,
    ),
  ).rejects.toThrow("sourceTooLarge");
  expect(bounded.calls.some((call) => /zipball|codeload/.test(call.url))).toBe(false);
});
