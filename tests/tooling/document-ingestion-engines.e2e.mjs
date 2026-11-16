import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";

const image = process.env.PANDA_FORCE_WORKER_TEST_IMAGE;
if (!image) throw Error("Set PANDA_FORCE_WORKER_TEST_IMAGE to a verified local worker image.");
const root = await mkdtemp(join(tmpdir(), "panda-ingestion-engines-"));
const feature = createDocumentFeature({
  stateRoot: join(root, "state"),
  allowedRoots: [root],
  requireProject: () => ({}),
});
const evidence = [];
try {
  for (const [engine, theme] of [
    ["hexo", "panda.reader@1.0.0"],
    ["hexo", "panda.journal@1.0.0"],
    ["docusaurus", "panda.handbook@1.0.0"],
    ["docusaurus", "panda.reference@1.0.0"],
  ]) {
    const source = join(root, theme),
      path = engine === "hexo" ? "source-en/_posts/article.md" : "docs/article.md";
    const localImage = engine === "hexo" ? "assets/diagram.png" : "static/assets/diagram.png";
    const content =
      engine === "hexo"
        ? '{% abstract "Overview" %}\nAbstract **body**.\n{% endabstract %}\n\n{% part "Part I" %}\n\n{% thesis %}\nA clear argument.\n{% endthesis %}\n\n{% lead %}\nOpening paragraph.\n{% endlead %}\n\n{% figure "/assets/diagram.png" "Diagram" 48 36 %}\nFigure caption.\n{% endfigure %}\n'
        : "# Handbook\n\n![Diagram](/assets/diagram.png)\n\nFigure caption.\n";
    for (const [file, data] of [
      [path, content],
      [
        "package.json",
        JSON.stringify({ dependencies: engine === "hexo" ? { hexo: "8.1.1" } : { "@docusaurus/core": "3.10.2" } }),
      ],
      [
        localImage,
        await sharp({ create: { width: 48, height: 36, channels: 3, background: "#425ee8" } })
          .png()
          .toBuffer(),
      ],
    ]) {
      await mkdir(dirname(join(source, file)), { recursive: true });
      await writeFile(join(source, file), data);
    }
    const space = await feature.service.createSpace({
      projectId: "project",
      code: theme.replace(/[^a-z0-9]/g, "-"),
      theme,
      name: engine,
      engine,
      sourceMode: "external",
      sourceRoot: source,
      locale: "en",
    });
    const imported = await feature.service.importSource(space.id);
    assert.equal(imported.assets.imported, 1);
    assert.deepEqual(imported.assets.issues, []);
    const capture = await documentBuildSources({
      service: feature.service,
      assets: feature.assets,
      snapshots: feature.snapshots,
    }).capture({
      id: randomUUID(),
      spaceId: space.id,
      engine,
      locale: "en",
      title: "Imported site",
      url: "https://example.test",
      basePath: "/guide/",
    });
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
        "--tmpfs",
        "/work:rw,nosuid,nodev,size=512m,mode=1777",
        image,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 150000 },
    );
    child.stdin.write(JSON.stringify(capture.input) + "\n");
    child.stdin.end();
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, errors.slice(-6000));
    const artifact = JSON.parse(output);
    const html = artifact.files
      .filter((file) => file.path.endsWith(".html"))
      .map((file) => Buffer.from(file.data, "base64").toString())
      .join("\n");
    const asset = artifact.files.find((file) => file.path.endsWith("/diagram.png"));
    assert.ok(asset, "Imported named image must exist in the generated artifact");
    assert.equal(asset.sha256, capture.input.assets[0].sha256);
    assert.match(html, /Figure caption\./);
    assert.equal(capture.input.theme.id, theme.split("@")[0]);
    const styles = artifact.files
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => Buffer.from(file.data, "base64").toString())
      .join("\n");
    if (theme.startsWith("panda.journal")) {
      assert.ok(html.includes("Georgia,Charter,serif"));
      assert.ok(html.includes("#845738"));
    }
    if (theme.startsWith("panda.reference")) assert.ok(styles.includes("--ifm-container-width-xl:1280px"));
    assert.ok(html.includes("/guide/assets/"), "Generated image URL includes the base path");
    assert.ok(!html.includes("/guide/guide/assets/"), "Base path is added once");
    if (engine === "hexo") {
      assert.match(html, /panda-abstract/);
      assert.match(html, /<figure>/);
      assert.match(html, /<figcaption>/);
      assert.ok(!html.includes("{% figure"));
      assert.match(html, /<strong>body<\/strong>/);
    }
    assert.equal(await readFile(join(source, path), "utf8"), content);
    evidence.push({
      engine,
      theme,
      immutableSourceSha256: createHash("sha256").update(content).digest("hex"),
      files: artifact.files.length,
      image: asset.path,
      passed: true,
    });
  }
  await mkdir(".artifacts/document-ingestion", { recursive: true });
  await writeFile(".artifacts/document-ingestion/engines.json", JSON.stringify({ image, evidence }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, evidence }));
} finally {
  feature.close();
  await rm(root, { recursive: true, force: true });
}
