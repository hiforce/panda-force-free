import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PortableTemplateTypes } from "../../src/shared/templates/types/registry.js";
import { PortableTemplateSource } from "../../src/server/templates/portable/source.js";
import { PortableTemplateInstallation } from "../../src/server/templates/portable/installation.js";
import { PortableTemplateInspection } from "../../src/server/templates/portable/inspection.js";
import { openPortableTemplateDatabase } from "../../src/server/templates/storage/database.js";
import { SqlitePortableTemplates } from "../../src/server/templates/storage/registry.js";
import { FilePortableTemplates } from "../../src/server/templates/storage/content.js";
import { portableFixture, fixtureBytes, editPortableFixture } from "../support/portable-templates.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-portable-templates-")),
    database = join(root, "registry.sqlite"),
    content = new FilePortableTemplates(join(root, "content"));
  let db = openPortableTemplateDatabase(database);
  const services = () => {
    const store = new SqlitePortableTemplates(db),
      types = new PortableTemplateTypes();
    return {
      store,
      installation: new PortableTemplateInstallation(store, content, types),
      inspection: new PortableTemplateInspection(store, content, types),
    };
  };
  return {
    root,
    database,
    content,
    get db() {
      return db;
    },
    services,
    restart() {
      db.close();
      db = openPortableTemplateDatabase(database);
      return services();
    },
    async dispose() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const articleKey = "example.article-outline@1.0.0";

test("selected portable installs retain file-backed identities, receipts and disabled state after a retry and restart", async () => {
  const f = await fixture();
  try {
    let services = f.services();
    const bytes = fixtureBytes(await portableFixture()),
      upload = await PortableTemplateSource.read(bytes, "mixed.json"),
      review = await services.installation.review(upload, [articleKey]);
    const approval = {
      operationId: randomUUID(),
      expectedRevision: review.revision,
      reviewHash: review.reviewHash,
      selected: review.selected,
    };
    const result = await services.installation.install(upload, approval, "owner");
    expect(result.receipt.results.map((item) => item.status)).toEqual(["installed"]);
    expect(result.current.templates).toHaveLength(1);
    const installed = result.current.templates[0]!;
    expect(installed.origin).toEqual(upload.origin);
    expect(installed.active).toBe(true);
    expect((await services.inspection.preview(installed.id, installed.version, installed.digest)).model.kind).toBe(
      "document",
    );
    const disabled = services.inspection.state(
      installed.id,
      installed.version,
      installed.digest,
      "disable",
      result.current.revision,
      "owner",
    );
    const retried = await services.installation.install(upload, approval, "owner");
    expect(retried.receipt).toEqual(result.receipt);
    expect(retried.current.revision).toBe(disabled.revision);
    expect(retried.current.templates[0]!.enabled).toBe(false);
    await expect(
      services.installation.install(upload, { ...approval, selected: ["example.brand-slides@1.0.0"] }, "owner"),
    ).rejects.toThrow("operationConflict");
    services = f.restart();
    expect(services.inspection.snapshot()).toEqual(retried.current);
    const restored = await services.installation.install(upload, approval, "owner");
    expect(restored.receipt).toEqual(result.receipt);
    expect(restored.current.templates[0]!.enabled).toBe(false);
    expect((await readdir(join(f.root, "content"))).sort()).toEqual([installed.digest + ".json"]);
    expect(await readFile(join(f.root, "content", installed.digest + ".json"), "utf8")).toContain(
      '"panda-force.template-bundle"',
    );
    const metadata = f.db
      .query<{ manifest: string; origin: string }, []>("SELECT manifest,origin FROM portable_template_versions")
      .get()!;
    expect(metadata.manifest).not.toContain("Write for the chosen audience");
    expect(metadata.manifest).not.toContain('"contentSlots"');
    expect(JSON.parse(metadata.origin).sha256).toBe(upload.origin.sha256);
    expect(
      f.db.query<{ count: number }, []>("SELECT count(*) AS count FROM portable_template_audit").get()!.count,
    ).toBe(2);
  } finally {
    await f.dispose();
  }
});

test("review binds the exact selection and immutable content, and updates cannot reactivate a retained version", async () => {
  const f = await fixture();
  try {
    const { installation, inspection } = f.services();
    const value = await portableFixture(),
      upload = await PortableTemplateSource.read(fixtureBytes(value), "templates.json");
    const reviewed = await installation.review(upload, [articleKey]);
    const approval = {
      operationId: randomUUID(),
      expectedRevision: reviewed.revision,
      reviewHash: reviewed.reviewHash,
      selected: reviewed.selected,
    };
    await expect(
      installation.install(upload, { ...approval, selected: ["example.brand-slides@1.0.0"] }, "owner"),
    ).rejects.toThrow("reviewChanged");
    await installation.install(upload, approval, "owner");
    await expect(installation.install(upload, { ...approval, operationId: randomUUID() }, "owner")).rejects.toThrow(
      "registryConflict",
    );
    await editPortableFixture(value, "example.article-outline", (_, payload) => {
      payload.instructions = "Different immutable body";
    });
    const changed = await PortableTemplateSource.read(fixtureBytes(value), "templates.json"),
      conflict = await installation.review(changed, [articleKey]);
    await expect(
      installation.install(
        changed,
        {
          operationId: randomUUID(),
          expectedRevision: conflict.revision,
          reviewHash: conflict.reviewHash,
          selected: conflict.selected,
        },
        "owner",
      ),
    ).rejects.toThrow("immutableVersion");
    expect(inspection.snapshot().templates).toHaveLength(1);
    await editPortableFixture(value, "example.article-outline", (manifest) => {
      manifest.version = "2.0.0";
    });
    const newer = await PortableTemplateSource.read(fixtureBytes(value), "templates.json"),
      upgrade = await installation.review(newer, ["example.article-outline@2.0.0"]);
    await installation.install(
      newer,
      {
        operationId: randomUUID(),
        expectedRevision: upgrade.revision,
        reviewHash: upgrade.reviewHash,
        selected: upgrade.selected,
      },
      "owner",
    );
    let snapshot = inspection.snapshot();
    const current = snapshot.templates.find((item) => item.version === "2.0.0")!,
      prior = snapshot.templates.find((item) => item.version === "1.0.0")!;
    expect(current.active).toBe(false);
    expect(prior.active).toBe(true);
    inspection.state(current.id, current.version, current.digest, "activate", snapshot.revision, "owner");
    snapshot = inspection.snapshot();
    inspection.state(current.id, current.version, current.digest, "disable", snapshot.revision, "owner");
    snapshot = inspection.snapshot();
    expect(snapshot.templates.some((item) => item.active)).toBe(false);
    const retained = await installation.review(upload, [articleKey]);
    const reapplied = await installation.install(
      upload,
      {
        operationId: randomUUID(),
        expectedRevision: retained.revision,
        reviewHash: retained.reviewHash,
        selected: retained.selected,
      },
      "owner",
    );
    expect(reapplied.receipt.results[0]!.status).toBe("retained");
    expect(reapplied.current.templates.some((item) => item.active)).toBe(false);
    expect(
      inspection.state(prior.id, prior.version, prior.digest, "activate", reapplied.current.revision, "owner").template
        .active,
    ).toBe(true);
  } finally {
    await f.dispose();
  }
});

test("unsupported templates remain inspectable candidates but selected unsupported types cannot install", async () => {
  const f = await fixture();
  try {
    const value = await portableFixture();
    await editPortableFixture(value, "example.brand-slides", (manifest) => {
      manifest.templateType = "example.future-type";
    });
    const upload = await PortableTemplateSource.read(fixtureBytes(value), "future.json"),
      { installation, inspection } = f.services(),
      review = await installation.review(upload);
    expect(review.candidates.find((item) => item.key === "example.brand-slides@1.0.0")).toMatchObject({
      supported: false,
      issue: "unsupportedType",
    });
    expect(review.selected).toHaveLength(2);
    const blocked = await installation.review(upload, ["example.brand-slides@1.0.0"]);
    await expect(
      installation.install(
        upload,
        {
          operationId: randomUUID(),
          expectedRevision: blocked.revision,
          reviewHash: blocked.reviewHash,
          selected: blocked.selected,
        },
        "owner",
      ),
    ).rejects.toThrow("unsupportedType");
    expect(inspection.snapshot().revision).toBe(0);
    await installation.install(
      upload,
      {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
      "owner",
    );
    expect(inspection.snapshot().templates).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("content corruption fails closed and a concurrent registry change cannot bypass the final installation transaction", async () => {
  const f = await fixture();
  try {
    const { installation, inspection, store } = f.services(),
      upload = await PortableTemplateSource.read(fixtureBytes(await portableFixture()), "templates.json"),
      review = await installation.review(upload, [articleKey]);
    const installed = (
      await installation.install(
        upload,
        {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
        },
        "owner",
      )
    ).current.templates[0]!;
    const competing = new PortableTemplateInstallation(
      store,
      {
        read: (digest) => f.content.read(digest),
        async put(value) {
          await f.content.put(value);
          inspection.state(
            installed.id,
            installed.version,
            installed.digest,
            "disable",
            inspection.snapshot().revision,
            "owner",
          );
        },
      },
      new PortableTemplateTypes(),
    );
    const selected = await competing.review(upload, ["example.brand-slides@1.0.0"]);
    await expect(
      competing.install(
        upload,
        {
          operationId: randomUUID(),
          expectedRevision: selected.revision,
          reviewHash: selected.reviewHash,
          selected: selected.selected,
        },
        "owner",
      ),
    ).rejects.toThrow("registryConflict");
    expect(inspection.snapshot().templates).toHaveLength(1);
    await writeFile(join(f.root, "content", installed.digest + ".json"), "{}");
    await expect(inspection.preview(installed.id, installed.version, installed.digest)).rejects.toThrow("unavailable");
  } finally {
    await f.dispose();
  }
});
