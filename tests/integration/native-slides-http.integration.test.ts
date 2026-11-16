import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { authenticatedHttp } from "../support/authenticated-http.js";
import { nativeSlidesFixture } from "../support/native-slides.js";
import type { SourceStageView } from "../../src/shared/packages/stages/contracts.js";
import type {
  NativeSlidesProposal,
  NativeSlidesReview,
  NativeSlidesInstallResult,
} from "../../src/shared/slides/registry.js";
import type { TemplateCatalogPage } from "../../src/shared/templates/catalog.js";
import type { TemplateSourceInspection } from "../../src/shared/templates/sources/contracts.js";

test("native Office HTTP admission, approval, private downloads and recovery use the real application boundary", async () => {
  const app = await createAppFixture(),
    client = authenticatedHttp(app.base),
    fixture = await nativeSlidesFixture();
  const root = "/api/templates/native-slides";
  try {
    expect((await client.request(root)).status).toBe(401);
    await client.signIn();
    const stage = await client.json<SourceStageView>("/api/package-sources", {
      purpose: "templates",
      operationId: randomUUID(),
      request: {
        source: {
          kind: "zip-upload",
          name: "private.potx",
          bytes: fixture.original.length,
          sha256: createHash("sha256").update(fixture.original).digest("hex"),
        },
      },
    });
    await client.json(
      "/api/package-sources/upload?" +
        new URLSearchParams({ purpose: "templates", id: stage.id, revision: String(stage.revision) }),
      fixture.original,
    );
    const ready = await waitFor(async () => {
      const value = await client.json<SourceStageView>("/api/package-sources/task?purpose=templates&id=" + stage.id);
      if (value.state === "failed") throw Error(value.failure!);
      return value.state === "ready" ? value : null;
    });
    const discovery = await client.json<TemplateSourceInspection>("/api/templates/source-discovery?id=" + stage.id);
    expect(discovery.candidates.find((c) => c.kind === "powerpoint-template")!.location).toEqual({ kind: "archive" });
    expect(discovery.importableKinds).toContain("powerpoint-template");
    const source = { id: ready.id, sha256: ready.digest!, selection: { kind: "archive" as const } };
    const prepared = await client.json<NativeSlidesProposal>(root + "/prepare", { source });
    expect(prepared.original.source.sha256).toBe(fixture.mapping.sourceSha256);
    expect(prepared.definition).toBeNull();
    expect((await client.request(root + "/part", { source, part: "../../private.xml" })).status).toBe(400);
    const input = {
      source,
      definition: {
        settings: fixture.settings,
        mapping: fixture.mapping,
        licenseText: fixture.license,
        readmeText: fixture.readme,
      },
    };
    const crossOrigin = await client.request(root + "/review", input, "POST", { origin: "https://other.example.test" });
    expect(crossOrigin.status).toBe(401);
    const review = await client.json<NativeSlidesReview>(root + "/review", input);
    expect(review.licenseText).toBe(fixture.license);
    const approval = {
      operationId: randomUUID(),
      expectedRevision: review.revision,
      reviewHash: review.reviewHash,
      licenseAcknowledged: true,
    };
    expect(
      (await client.request(root + "/install", { ...input, approval: { ...approval, licenseAcknowledged: false } }))
        .status,
    ).toBe(403);
    expect(
      (await client.request(root + "/install", { ...input, approval: { ...approval, reviewHash: "f".repeat(64) } }))
        .status,
    ).toBe(409);
    const installed = await client.json<NativeSlidesInstallResult>(root + "/install", { ...input, approval });
    const selected = installed.current.templates[0]!,
      ref = { id: selected.id, version: selected.version, digest: selected.digest },
      query = new URLSearchParams(ref);
    const original = await client.request(root + "/original?" + query);
    expect(original.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.template",
    );
    expect(original.headers.get("content-disposition")).toContain('filename="export.potx"');
    expect(original.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(fixture.original));
    const archive = await client.request(root + "/export?" + query),
      bytes = new Uint8Array(await archive.arrayBuffer()),
      files = unzipSync(bytes);
    expect(files["original.potx"]).toEqual(fixture.original);
    expect(new TextDecoder().decode(files.LICENSE)).toBe(fixture.license);
    expect((await fetch(app.base + root + "/original?" + query)).status).toBe(401);
    for (const action of ["detail", "content", "original", "export"]) {
      expect((await client.request(`${root}/${action}?${query}&actor=forged`)).status).toBe(400);
      expect((await client.request(`${root}/${action}?${query}&id=duplicate`)).status).toBe(400);
    }
    const catalog = await client.json<TemplateCatalogPage>("/api/template-catalog?registry=native-slides");
    expect(catalog.templates).toHaveLength(1);
    expect(catalog.templates[0]!.actions).toMatchObject({ preview: null, export: "native-slides-zip" });
    expect(catalog.templates[0]!.origin).toMatchObject({ sha256: ready.digest });
    await client.json(
      root + "/state",
      { reference: ref, action: "disable", expectedRevision: installed.current.revision },
      "PUT",
    );
    await client.json("/api/package-sources/remove", { purpose: "templates", id: ready.id, revision: ready.revision });
    await app.stop();
    await app.start();
    const replay = await client.json<NativeSlidesInstallResult>(root + "/install", { ...input, approval });
    expect(replay.receipt).toEqual(installed.receipt);
    expect(replay.current.templates[0]!.enabled).toBe(false);
    expect(new Uint8Array(await (await client.request(root + "/export?" + query)).arrayBuffer())).toEqual(bytes);
  } finally {
    await app.dispose();
  }
}, 30000);
