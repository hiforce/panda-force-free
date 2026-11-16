import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import sharp from "sharp";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectDocumentBuildSources } from "../../src/server/builds/integration/project-document-sources.js";
import { builtinSiteThemes } from "../../src/shared/presentation/themes.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";

const image = process.env.PANDA_FORCE_WORKER_TEST_IMAGE;
if (!image) throw Error("Set PANDA_FORCE_WORKER_TEST_IMAGE to a verified local worker image.");
const root = await mkdtemp(join(tmpdir(), "panda-rich-engines-")),
  feature = createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject: () => ({}) }),
  evidence = [];
let files = null;
try {
  const source = feature.library.create("project", { title: "One original", locale: "en" }),
    bytes = await sharp({ create: { width: 48, height: 36, channels: 3, background: "#425ee8" } })
      .png()
      .toBuffer(),
    asset = await feature.assets.upload(source.document.id, "My original.png", bytes),
    literal = 'A <script> literal {process.env.KEY} **text** {% include "secret" %}',
    saved = feature.service.saveDocument(source.document.id, {
      revision: 1,
      title: "Original source title",
      locale: "en",
      body: {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2, textAlign: "center" },
              content: [{ type: "text", text: literal, marks: [{ type: "underline" }, { type: "bold" }] }],
            },
            {
              type: "paragraph",
              attrs: { textAlign: "right" },
              content: [
                {
                  type: "text",
                  text: "A safe link",
                  marks: [{ type: "link", attrs: { href: "https://example.test/guide" } }],
                },
              ],
            },
            {
              type: "codeBlock",
              attrs: { language: "js" },
              content: [{ type: "text", text: 'const x = "<div>";\nconsole.log({x});' }],
            },
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableHeader",
                      attrs: { colspan: 2, colwidth: [120, 140] },
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Merged title" }] }],
                    },
                  ],
                },
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableCell",
                      attrs: { rowspan: 2, colwidth: [120] },
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Two rows" }] }],
                    },
                    { type: "tableCell", attrs: { colwidth: [140] }, content: [{ type: "paragraph" }] },
                  ],
                },
                {
                  type: "tableRow",
                  content: [{ type: "tableCell", attrs: { colwidth: [140] }, content: [{ type: "paragraph" }] }],
                },
              ],
            },
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: true },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Reviewed" }] }],
                },
              ],
            },
            {
              type: "image",
              attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "Rich image", width: 48, height: 36 },
            },
          ],
        },
      },
    });
  const sources = documentBuildSources({
    service: feature.service,
    assets: feature.assets,
    snapshots: feature.snapshots,
  });
  async function verify(capture, source, asset, saved, placement, storage) {
    const engine = capture.input.engine;
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
    const artifact = JSON.parse(output),
      page = artifact.files
        .filter((file) => file.path.endsWith(".html"))
        .map((file) => ({ file, dom: new JSDOM(Buffer.from(file.data, "base64").toString()) }))
        .find((page) => page.dom.window.document.querySelector("h2")?.textContent === literal);
    assert.ok(page, "The literal rich heading must survive the actual engine unchanged");
    const document = page.dom.window.document;
    assert.equal(document.querySelector("h2").style.textAlign, "center");
    assert.ok(document.querySelector("h2 u strong") || document.querySelector("h2 strong u"));
    assert.equal(document.querySelector("th").colSpan, 2);
    assert.equal(document.querySelector("td").rowSpan, 2);
    assert.equal(document.querySelector('input[type="checkbox"]').checked, true);
    assert.equal(document.querySelector('input[type="checkbox"]').disabled, true);
    assert.ok(document.querySelector("pre").textContent.includes("console.log({x});"));
    const generated = document.querySelector('img[alt="Rich image"]'),
      url = generated.getAttribute("src");
    assert.equal(url, `/guide/assets/${source.document.id}/${asset.id}/My%20original.png`);
    assert.equal(generated.width, 48);
    const outputImage = artifact.files.find((file) => file.path === decodeURIComponent(url.replace(/^\/guide\//, "")));
    assert.ok(outputImage, "The emitted image URL must resolve to a published file");
    assert.equal(outputImage.sha256, asset.digest);
    assert.equal(capture.sources[0].contentHash, saved.revision.contentHash);
    assert.equal(capture.sources[0].placement.id, placement.id);
    evidence.push({
      engine,
      storage,
      passed: true,
      files: artifact.files.length,
      imagePath: outputImage.path,
      richHash: saved.revision.contentHash,
      placementVersion: placement.version,
    });
    console.log(JSON.stringify({ engine, storage, passed: true }));
  }
  for (const engine of ["hexo", "docusaurus"]) {
    const space = await feature.service.createSpace({
      projectId: "project",
      code: engine,
      name: engine,
      engine,
      sourceMode: "managed",
      locale: "en",
    });
    const placement = feature.placements.create(
      {
        id: randomUUID(),
        documentId: saved.document.id,
        spaceId: space.id,
        path: "guide/intro.md",
        locale: "en",
        metadata: { title: "Published heading" },
      },
      "isolated-engine-test",
    );
    const capture = await sources.capture({
      id: randomUUID(),
      spaceId: space.id,
      engine,
      locale: "en",
      title: "Rich site",
      url: "https://example.test",
      basePath: "/guide/",
    });
    await verify(capture, source, asset, saved, placement, "legacy");
    assert.deepEqual(feature.service.detail(saved.document.id), saved);
  }
  files = await projectFileApiFixture();
  const fileApplication = files.application(),
    fileAsset = await fileApplication.assets.upload(
      "tooling:build",
      "project-1",
      "doc-1",
      "My original.png",
      randomUUID(),
      bytes,
    ),
    fileBody = JSON.parse(JSON.stringify(saved.revision.body).replaceAll(asset.id, fileAsset.id));
  await fileApplication.editor.autosave("tooling:build", "project-1", "doc-1", {
    operationId: randomUUID(),
    version: 0,
    baseRevisionId: files.detail.revision.id,
    working: { title: "Original source title", locale: "en", body: fileBody },
  });
  const fileSaved = (
    await fileApplication.editor.save("tooling:build", "project-1", "doc-1", {
      operationId: randomUUID(),
      revisionId: files.detail.revision.id,
      draftVersion: 1,
    })
  ).detail;
  const fileSources = projectDocumentBuildSources({ ...fileApplication, themes: builtinSiteThemes });
  for (const engine of ["hexo", "docusaurus"]) {
    const space = await fileApplication.spaces.create("tooling:build", {
        operationId: randomUUID(),
        projectId: "project-1",
        code: engine,
        name: engine,
        engine,
        sourceMode: "managed",
        locale: "en",
        theme: "default",
      }),
      placement = await fileApplication.placements.create("tooling:build", "project-1", {
        operationId: randomUUID(),
        id: randomUUID(),
        documentId: fileSaved.document.id,
        spaceId: space.id,
        spaceVersion: 1,
        path: "guide/intro.md",
        locale: "en",
        revisionId: fileSaved.revision.id,
        metadata: { title: "Published heading" },
      }),
      capture = await fileSources.capture({
        id: randomUUID(),
        projectId: "project-1",
        spaceId: space.id,
        spaceVersion: 2,
        engine,
        locale: "en",
        title: "Rich site",
        url: "https://example.test",
        basePath: "/guide/",
      });
    await verify(capture, fileSaved, fileAsset, fileSaved, placement, "files");
    assert.equal(capture.sourceSnapshot.projectId, "project-1");
    assert.match(capture.sourceSnapshot.commit, /^[a-f0-9]{40}$/);
    const unchanged = await fileApplication.queries.detail("project-1", fileSaved.document.id);
    assert.deepEqual(unchanged.document, fileSaved.document);
    assert.deepEqual(unchanged.revision, fileSaved.revision);
    assert.equal(unchanged.engine, "markdown");
    assert.equal(unchanged.sourceMode, "managed");
  }
  await mkdir(".artifacts/document-placement-engines", { recursive: true });
  await writeFile(
    ".artifacts/document-placement-engines/verified.json",
    JSON.stringify({ image, evidence }, null, 2) + "\n",
  );
} finally {
  await files?.close();
  feature.close();
  await rm(root, { recursive: true, force: true });
}
