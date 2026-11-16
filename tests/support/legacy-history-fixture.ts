import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socialFixture } from "./social-publication-fixture.js";
import { createEditorialFeature } from "../../src/server/editorial/integration/feature.js";
import { documentEditorialSources } from "../../src/server/editorial/integration/document-source.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import { PublicationRepository } from "../../src/server/delivery/repository.js";
import { digest } from "../../src/server/delivery/digest.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import { LegacyProjectDocuments } from "../../src/server/project-content/migration/legacy-documents.js";
import { inventoryLegacyProjectHistory } from "../../src/server/content-migration/history/inventory.js";
import type { SitePublicationPlan } from "../../src/shared/delivery/contracts.js";
import type { PublicationConnection } from "../../src/shared/connections/contracts.js";
import { issueKey } from "../../src/server/publishing/variant-service.js";

/** Real domain writers seed an offline backup; simulated platform requests never leave the fixture. */
export async function legacyHistoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-history-cutover-"));
  const f = await socialFixture("One original  with spaces.", {
    async respond() {
      throw new RemoteOperationError("platformUnavailable", "unknown");
    },
  });
  try {
    const db = f.documents.persistence,
      source = f.documents.service.saveDocument(f.document.document.id, {
        revision: 1,
        title: "Rich original",
        locale: "en",
        body: {
          schema: 1,
          format: "richtext",
          document: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "One  original." }] }],
          },
        },
      }),
      editorial = createEditorialFeature(db, documentEditorialSources(f.documents.service, db)),
      proposal = await editorial.service.prepare("owner", {
        id: randomUUID(),
        documentId: source.document.id,
        revisionId: source.revision.id,
        mode: "spacing",
      }),
      pendingProposal = await editorial.service.prepare("owner", {
        id: randomUUID(),
        documentId: source.document.id,
        revisionId: source.revision.id,
        mode: "spacing",
      });
    await editorial.service.accept("owner", {
      id: proposal.proposal.id,
      digest: proposal.digest,
      selected: [proposal.proposal.edits[0]!.id],
    });
    const current = f.documents.service.detail(source.document.id),
      variant = await f.publishing.variants.prepare({
        documentId: current.document.id,
        revisionId: current.revision.id,
        format: "x-post",
        mode: "format",
        templateId: "technical",
      });
    await f.publishing.variants.review(
      variant.variant.id,
      {
        digest: variant.digest,
        acceptedIssues: variant.variant.issues.map(issueKey),
      },
      "reviewer",
    );
    const social = await f.prepare(variant.variant.id),
      space = await f.documents.service.createSpace({
        projectId: f.space.projectId,
        code: "website",
        name: "Website",
        engine: "hexo",
        sourceMode: "managed",
        locale: "en",
      }),
      builds = new SiteBuildRepository(db),
      build = builds.create(
        {
          id: randomUUID(),
          spaceId: space.id,
          engine: "hexo",
          title: "Website",
          locale: "en",
          url: "https://example.test",
          basePath: "/",
        },
        {
          protocol: 1,
          engine: "hexo",
          preset: "reader",
          site: { title: "Website", locale: "en", url: "https://example.test", basePath: "/" },
          documents: [
            {
              id: f.document.document.id,
              path: "original.md",
              title: "Original",
              content: f.document.revision.content,
            },
          ],
          assets: [],
        },
        [
          {
            id: f.document.document.id,
            path: "original.md",
            revisionId: f.document.revision.id,
            contentHash: f.document.revision.contentHash,
          },
        ],
      ),
      completed = builds.update(build.id, { phase: "completed", artifactAvailable: false }),
      sites = new PublicationRepository(db),
      connection: PublicationConnection = {
        id: randomUUID(),
        projectId: f.space.projectId,
        name: "Offline destination",
        connector: "local-site",
        root: "local",
        directory: "isolated",
        publicUrl: "https://example.test/",
        version: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      request = { id: randomUUID(), buildId: build.id, connectionId: connection.id, connectionVersion: 1 },
      artifact = {
        protocol: 1 as const,
        files: [
          {
            path: "index.html",
            data: Buffer.from("Original output").toString("base64"),
            sha256: digest("Original output"),
          },
        ],
        bytes: Buffer.byteLength("Original output"),
      },
      buildSource = {
        id: completed.id,
        site: completed.site,
        engine: completed.engine,
        inputHash: completed.inputHash,
        sources: completed.sources,
        image: completed.image,
      },
      plan: SitePublicationPlan = {
        ...request,
        projectId: f.space.projectId,
        spaceId: space.id,
        connection,
        build: buildSource,
        fingerprint: digest(
          JSON.stringify({
            request,
            build: buildSource,
            connection,
            files: artifact.files.map(({ path, sha256 }) => ({ path, sha256 })),
          }),
        ),
        fileCount: 1,
        outputBytes: artifact.bytes,
        servedPath: "/isolated/current",
        createdAt: 1,
        expiresAt: Date.now() + 86_400_000,
      };
    sites.prepare("owner", request, plan, artifact);
    const backup = async () => {
      const path = join(root, randomUUID() + ".sqlite");
      await writeFile(path, db.serialize());
      // Finalize the independent copy as a standalone rollback-journal backup before opening its reader.
      const copy = new Database(path);
      try {
        copy.exec("PRAGMA journal_mode=DELETE");
      } finally {
        copy.close();
      }
      return path;
    };
    const inspect = async () => {
      const path = await backup(),
        before = await readFile(path),
        source = await LegacyProjectDocuments.open(path, f.space.projectId);
      try {
        const result = inventoryLegacyProjectHistory(source);
        await source.assertSourceUnchanged();
        return { result, path, before, after: await readFile(path) };
      } finally {
        source.close();
      }
    };
    return {
      f,
      root,
      db,
      variant,
      social,
      source,
      proposal,
      pendingProposal,
      editorial,
      builds,
      build,
      completed,
      sites,
      plan,
      backup,
      inspect,
      async editBackup(change: (db: Database) => void) {
        const path = await backup(),
          copy = new Database(path);
        try {
          change(copy);
        } finally {
          copy.close();
        }
        return path;
      },
      async close() {
        await editorial.stop();
        await f.dispose();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await f.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
