import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createPluginFeature } from "../../src/server/plugins/integration/feature.js";
import { documentThemePackager } from "../../src/server/plugins/integration/source-theme.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";
import { DEFAULT_THEME_DEPENDENCIES } from "../../src/shared/builds/toolchain.js";

const image = process.env.PANDA_FORCE_WORKER_TEST_IMAGE,
  source = process.env.PANDA_FORCE_SOURCE_PROFILE_TEST_ROOT,
  themeName = process.env.PANDA_FORCE_SOURCE_PROFILE_TEST_THEME,
  editions = JSON.parse(process.env.PANDA_FORCE_SOURCE_PROFILE_TEST_EDITIONS || "{}");
if (!image || !source || !themeName || !Object.keys(editions).length)
  throw Error(
    "Select a local worker, authorized read-only source root, theme and edition configuration files explicitly.",
  );
const root = await mkdtemp(join(tmpdir(), "panda-source-engine-")),
  evidence = process.env.PANDA_FORCE_SOURCE_PROFILE_TEST_EVIDENCE;
const plugins = createPluginFeature({ stateRoot: root, owner: () => "read-only-fixture" });
const documents = createDocumentFeature({
  stateRoot: root,
  allowedRoots: [source],
  requireProject: () => ({}),
  themes: plugins.themes,
});
const results = [];
try {
  let space = await documents.service.createSpace({
    projectId: "fixture",
    code: "read-only",
    name: "Read-only source verification",
    engine: "hexo",
    sourceMode: "external",
    sourceRoot: source,
    locale: Object.keys(editions)[0],
  });
  const packaged = await documentThemePackager(documents.service)(space.id, themeName, {
    schema: 1,
    id: "example.source-fixture",
    version: "1.0.0",
    name: "Read-only source theme",
    description: "Disposable source compatibility verification",
    permissions: ["content:site-themes", "build:theme-code"],
    channelTemplates: [],
    siteThemes: [
      {
        id: "site",
        name: "Read-only source theme",
        description: "",
        engine: "hexo",
        engineVersion: "8.1.1",
        root: "theme",
        dependencies: DEFAULT_THEME_DEPENDENCIES,
      },
    ],
  });
  const review = await plugins.service.review(packaged.package);
  await plugins.service.install(
    packaged.package,
    { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
    "read-only-fixture",
  );
  space = documents.service.updateTheme(space.id, {
    theme: "example.source-fixture.site@1.0.0",
    version: space.version,
  });
  for (const [locale, files] of Object.entries(editions)) {
    const proposal = await documents.profiles.inspect(space.id, locale, files, true);
    space = documents.profiles.save(space.id, proposal.profile, proposal.spaceVersion);
  }
  const imported = await documents.service.importSource(space.id);
  assert.equal(imported.truncated, false);
  assert.equal(imported.conflicts.length, 0);
  assert.equal(imported.skipped.length, 0);
  assert.equal(imported.assets.issuesTruncated, false);
  assert.equal(
    imported.assets.issues.length,
    0,
    "Every referenced local source image must be safely bound to its document revision.",
  );
  const sources = documentBuildSources({
    service: documents.service,
    assets: documents.assets,
    snapshots: documents.snapshots,
    captureTheme: plugins.captureTheme,
    profiles: documents.profiles,
  });
  for (const locale of Object.keys(editions)) {
    const edition = documents.profiles.get(space.id).editions[locale];
    const captured = await sources.capture({ id: randomUUID(), spaceId: space.id, engine: "hexo", ...edition, locale });
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=268435456,mode=1777",
        "--tmpfs",
        "/work:rw,nosuid,nodev,size=805306368,uid=1000,gid=1000,mode=0700",
        image,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 150000 },
    );
    child.stdin.write(JSON.stringify(captured.input) + "\n");
    child.stdin.end();
    const [out, log, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (evidence) {
      await mkdir(evidence, { recursive: true, mode: 0o700 });
      await writeFile(join(evidence, locale + ".worker.log"), log, { mode: 0o600 });
    }
    assert.equal(exit, 0, `Worker failed for ${locale}; inspect private worker logs.`);
    const artifact = JSON.parse(out),
      files = new Map(artifact.files.map((file) => [file.path, Buffer.from(file.data, "base64")]));
    for (const file of artifact.files)
      assert.equal(createHash("sha256").update(files.get(file.path)).digest("hex"), file.sha256);
    assert.ok(files.has("index.html"));
    const posts = captured.input.documents.filter(
      (doc) => doc.path.includes("/_posts/") && doc.metadata.published !== false && doc.metadata.draft !== true,
    );
    for (const post of posts) {
      assert.ok(files.has(`posts/${post.metadata.slug}/index.html`), "A saved post must retain its public slug.");
      const html = files.get(`posts/${post.metadata.slug}/index.html`).toString();
      assert.ok(html.includes(post.title), "The original title must be present.");
      assert.ok(!html.includes("{% figure"), "Native theme tags must render through approved scripts.");
    }
    for (const file of captured.input.project.files.filter((file) => file.publish)) {
      assert.ok(files.has(file.path), "Selected static resources must be emitted.");
      assert.equal(createHash("sha256").update(files.get(file.path)).digest("hex"), file.sha256);
    }
    const result = {
      locale,
      documents: captured.sources.length,
      posts: posts.length,
      resources: captured.input.project.files.length,
      inputBytes: Buffer.byteLength(JSON.stringify(captured.input)),
      outputFiles: artifact.files.length,
      outputBytes: artifact.bytes,
      themeDigest: captured.input.theme.sha256,
    };
    if (evidence) {
      const output = join(evidence, locale);
      await mkdir(output, { recursive: true, mode: 0o700 });
      for (const [path, bytes] of files) {
        await mkdir(join(output, path, ".."), { recursive: true, mode: 0o700 });
        await writeFile(join(output, path), bytes, { mode: 0o600 });
      }
    }
    results.push(result);
    console.log(JSON.stringify({ verified: result }));
  }
  if (evidence)
    await writeFile(
      join(evidence, "verification.private.json"),
      JSON.stringify({ image, packageDigest: packaged.digest, results }, null, 2) + "\n",
      { mode: 0o600 },
    );
} finally {
  documents.close();
  plugins.close();
  await rm(root, { recursive: true, force: true });
}
