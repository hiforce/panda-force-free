import { expect, test } from "bun:test";
import { contentSha256 } from "../../src/shared/packages/digest.js";
import {
  exportPortableTemplates,
  parsePortableTemplateBundle,
  verifyPortableTemplateTree,
} from "../../src/shared/templates/portable/bundle.js";
import { verifyPortableTemplateResources } from "../../src/shared/templates/portable/resources.js";
import { DEFAULT_TEMPLATE_RESOURCE_POLICY } from "../../src/shared/templates/portable/contracts.js";
import { templatePathSet } from "../../src/shared/templates/portable/validation.js";
import { PortableTemplateTypes } from "../../src/shared/templates/types/registry.js";
import { applyDocumentLayout } from "../../src/shared/templates/types/document.js";
import { marked } from "marked";
import { editPortableFixture, fixtureBytes, portableFixture } from "../support/portable-templates.js";

test("one portable library preserves three different typed models and exact resources through selective export", async () => {
  const input = await portableFixture(),
    verified = await parsePortableTemplateBundle(fixtureBytes(input)),
    types = new PortableTemplateTypes();
  expect(verified.templates.map((value) => types.prepare(value).model.kind).sort()).toEqual([
    "document",
    "site",
    "slides",
  ]);
  for (const original of verified.templates) {
    const roundtrip = await parsePortableTemplateBundle(exportPortableTemplates([original]));
    expect(roundtrip.templates).toHaveLength(1);
    const saved = roundtrip.templates[0]!;
    expect(saved.digest).toBe(original.digest);
    expect(saved.readManifest()).toEqual(original.readManifest());
    expect(saved.text(saved.manifest.license.file)).toContain("MIT License");
    for (const resource of saved.manifest.files)
      expect(saved.read(resource.path)).toEqual(original.read(resource.path));
    const copy = saved.readManifest();
    copy.fill(0);
    expect(saved.readManifest()).toEqual(original.readManifest());
  }
});

test("resource ownership is captured before hashing and imported paths cannot alias directories or escape the logical tree", async () => {
  const library = await parsePortableTemplateBundle(fixtureBytes(await portableFixture())),
    original = library.templates[0]!;
  const raw = original.readManifest(),
    files = original.manifest.files.map((item) => ({ path: item.path, bytes: original.read(item.path) }));
  const pending = verifyPortableTemplateResources(raw, files);
  raw.fill(0);
  for (const file of files) file.bytes.fill(0);
  const verified = await pending;
  expect(verified.digest).toBe(original.digest);
  for (const sequence of [
    ["a/payload.json", "A/LICENSE"],
    ["a", "a/data"],
    ["a/data", "a"],
    ["../key"],
    ["a/../b"],
    [".git/config"],
    ["auth.json"],
    ["a\\b"],
    ["re\u0301sume.json"],
    ["a/%2e%2e/file"],
  ]) {
    const add = templatePathSet();
    expect(() => sequence.forEach(add)).toThrow("invalidPath");
  }
  const unicode = templatePathSet();
  expect(unicode("资料/说明.json")).toBe("资料/说明.json");
});

test("tree verification rejects absent, extra, tampered and aliased resources before installation", async () => {
  const initial = await portableFixture();
  for (const change of [
    (input: typeof initial) => {
      input.files.pop();
    },
    (input: typeof initial) => {
      input.files.push({ path: "unexpected.txt", encoding: "base64", data: "eA==" });
    },
    (input: typeof initial) => {
      input.files[1]!.data = Buffer.from("tampered").toString("base64");
    },
    (input: typeof initial) => {
      input.files.push({ ...input.files[0]! });
    },
    (input: typeof initial) => {
      input.files[0]!.data = "A===";
    },
    (input: typeof initial) => {
      input.index.entries[0]!.categories = ["different"];
    },
  ]) {
    const input = structuredClone(initial);
    change(input);
    await expect(parsePortableTemplateBundle(fixtureBytes(input))).rejects.toThrow();
  }
  await expect(
    parsePortableTemplateBundle(fixtureBytes(initial), { ...DEFAULT_TEMPLATE_RESOURCE_POLICY, templates: 2 }),
  ).rejects.toThrow("packageTooLarge");
  await expect(
    verifyPortableTemplateTree(
      initial.index,
      initial.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.data, "base64") })),
      { ...DEFAULT_TEMPLATE_RESOURCE_POLICY, files: 2 },
    ),
  ).rejects.toThrow("packageTooLarge");
});

test("typed adapters reject unsupported code loading, incompatible APIs and invalid slide layouts", async () => {
  const types = new PortableTemplateTypes();
  for (const [edit, issue] of [
    [
      (manifest: Record<string, unknown>) => {
        manifest.templateType = "external.arbitrary";
      },
      "unsupportedType",
    ],
    [
      (manifest: Record<string, unknown>) => {
        manifest.requires = { adapters: [{ id: "panda.document-editor", api: 2 }], skills: [] };
      },
      "incompatibleAdapter",
    ],
  ] as const) {
    const input = await portableFixture();
    await editPortableFixture(input, "example.article-outline", (manifest) =>
      edit(manifest as unknown as Record<string, unknown>),
    );
    const article = (await parsePortableTemplateBundle(fixtureBytes(input))).templates.find(
      (value) => value.manifest.id === "example.article-outline",
    )!;
    expect(() => types.prepare(article)).toThrow(issue);
  }
  const input = await portableFixture();
  await editPortableFixture(input, "example.brand-slides", (_, payload) => {
    payload.sampleSlides = [{ layout: "missing", title: "Invalid layout" }];
  });
  const slides = (await parsePortableTemplateBundle(fixtureBytes(input))).templates.find(
    (value) => value.manifest.templateType === "panda.slides-template",
  )!;
  expect(() => types.prepare(slides)).toThrow("invalidPayload");
});

test("document templates substitute once, validate parameters and bound repeated expansion before allocating output", async () => {
  const source = (await parsePortableTemplateBundle(fixtureBytes(await portableFixture()))).templates.find(
    (item) => item.manifest.id === "example.article-outline",
  )!;
  const model = new PortableTemplateTypes().prepare(source).model;
  if (model.kind !== "document") throw Error("Expected a document model");
  const rendered = applyDocumentLayout(model, source.manifest, { title: "A title", introduction: "Literal {{title}}" });
  expect(rendered).toContain("# A title\n");
  expect(rendered).toContain("Literal {{title}}");
  const literal = applyDocumentLayout(
    {
      ...model,
      content: "{{title}}\n\n{{literal}}",
      contentSlots: [{ id: "literal", kind: "plain-text", default: "" }],
    },
    source.manifest,
    { title: "**Not bold**", literal: '<img src="x" onerror="alert(1)">' },
  );
  const html = marked.parse(literal, { async: false });
  expect(html).not.toContain("<strong>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  for (const input of [{}, { title: null }, { title: "x", unknown: "injected" }])
    expect(() => applyDocumentLayout(model, source.manifest, input)).toThrow("invalidParameters");
  expect(() =>
    applyDocumentLayout({ ...model, content: "{{introduction}}".repeat(40) }, source.manifest, {
      title: "x",
      introduction: "x".repeat(64000),
    }),
  ).toThrow("invalidParameters");
});

test("large canonical base64 resources stay bounded without a regex stack overflow", async () => {
  const input = await portableFixture(),
    bytes = new Uint8Array(1024 * 1024).fill(120);
  await editPortableFixture(input, "example.article-outline", (manifest) => {
    manifest.files = [
      ...manifest.files,
      { path: "sample.txt", bytes: bytes.length, sha256: "0".repeat(64), mediaType: "text/plain" },
    ];
  });
  // Update the additional resource checksum while retaining the payload's independently verified identity.
  await editPortableFixture(input, "example.article-outline", (manifest) => {
    manifest.files = manifest.files.map((file) =>
      file.path === "sample.txt" ? { ...file, sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") } : file,
    );
  });
  const entry = input.index.entries.find((item) => item.id === "example.article-outline")!;
  input.files.push({
    path: entry.manifest.slice(0, entry.manifest.lastIndexOf("/") + 1) + "sample.txt",
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64"),
  });
  const verified = await parsePortableTemplateBundle(fixtureBytes(input));
  expect(
    await contentSha256(verified.templates.find((item) => item.manifest.id === entry.id)!.read("sample.txt")),
  ).toBe(await contentSha256(bytes));
});
