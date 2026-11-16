import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import { portableFixture } from "./portable-templates.js";
import { uploadBody } from "./source-upload.js";
import { createPackageSourceStages } from "../../src/server/packages/staging/feature.js";
import { openPortableTemplateDatabase } from "../../src/server/templates/storage/database.js";
import { SqlitePortableTemplates } from "../../src/server/templates/storage/registry.js";
import { FilePortableTemplates } from "../../src/server/templates/storage/content.js";
import { PortableTemplateInstallation } from "../../src/server/templates/portable/installation.js";
import { PortableTemplateInspection } from "../../src/server/templates/portable/inspection.js";
import { PortableTemplateTypes } from "../../src/shared/templates/types/registry.js";
import { SourceTemplateImport } from "../../src/server/templates/sources/import.js";
import type { PortableTemplateContent } from "../../src/server/templates/portable/ports.js";
import type { SourceHttpPort } from "../../src/server/packages/source-http.js";

export async function portableSourceArchive(root = "repository/library") {
  const bundle = await portableFixture(),
    prefix = root ? root + "/" : "",
    files: Record<string, Uint8Array> = {
      [prefix + "panda-templates.json"]: new TextEncoder().encode(JSON.stringify(bundle.index)),
      [prefix + "README.md"]: new TextEncoder().encode("Repository documentation stays in the source."),
    };
  for (const file of bundle.files) files[prefix + file.path] = Buffer.from(file.data, "base64");
  return { bytes: zipSync(files), bundle, root };
}
export async function sourceTemplateFixture(options: { http?: SourceHttpPort } = {}) {
  const root = await mkdtemp(join(tmpdir(), "panda-source-template-")),
    sources = createPackageSourceStages({ root: join(root, "sources"), ...options }),
    manager = sources.ingestion,
    database = join(root, "templates.sqlite"),
    content = new FilePortableTemplates(join(root, "content")),
    types = new PortableTemplateTypes();
  let db = openPortableTemplateDatabase(database);
  const reader = {
      project: <T>(actor: string, id: string, read: Parameters<typeof manager.project<T>>[3]) =>
        manager.project(actor, "templates", id, read),
    },
    consumer = {
      consume: <T>(actor: string, id: string, sha256: string, run: Parameters<typeof manager.consume<T>>[4]) =>
        manager.consume(actor, "templates", id, sha256, run),
    };
  function services(storage: PortableTemplateContent = content) {
    const store = new SqlitePortableTemplates(db),
      installation = new PortableTemplateInstallation(store, storage, types);
    return {
      store,
      installation,
      inspection: new PortableTemplateInspection(store, storage, types),
      importer: new SourceTemplateImport(reader, consumer, installation),
    };
  }
  return {
    root,
    database,
    manager,
    content,
    services,
    get db() {
      return db;
    },
    async stage(bytes: Uint8Array) {
      const task = await manager.submit("owner", "templates", randomUUID(), {
        source: {
          kind: "zip-upload",
          name: "library.zip",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
      await manager.upload("owner", "templates", task.id, task.revision, uploadBody(bytes).body);
      manager.poll();
      await manager.settle();
      return manager.read("owner", "templates", task.id);
    },
    restart() {
      db.close();
      db = openPortableTemplateDatabase(database);
      return services();
    },
    async close() {
      await sources.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
