import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileSocialSources } from "../../src/server/delivery/integration/file-social-sources.js";
import { mysqlFileSocialSources } from "../../src/server/delivery/integration/mysql-file-social-sources.js";
import type { VariantService } from "../../src/server/publishing/variant-service.js";
import type { SocialSource } from "../../src/shared/delivery/social.js";

test("social source capture awaits a saved variant guard before exposing content", async () => {
  const projectId = randomUUID(),
    documentId = randomUUID(),
    revisionId = randomUUID(),
    spaceId = randomUUID();
  const variants = {
    capture: async () => ({
      detail: { variant: { source: { projectId, documentId, revisionId } } },
      async guard() {
        await Promise.resolve();
        throw Error("revoked");
      },
    }),
  } as unknown as Pick<VariantService, "capture">;
  for (const create of [fileSocialSources, mysqlFileSocialSources]) {
    const sources = create({
      variants,
      reference: () => {
        throw Error("unused");
      },
      queries: { record: async () => ({ spaceId, revisionId }) as never },
      assets: {
        list: async () => [],
        content: async () => {
          throw Error("unused");
        },
      },
      spaces: {
        get: async () => {
          throw Error("unused");
        },
      },
      requireProject() {},
    });
    await expect(sources.capture("owner", randomUUID())).rejects.toThrow("revoked");
  }
});

test("native final source guards await current review identity and reject a later revocation", async () => {
  const projectId = randomUUID(),
    spaceId = randomUUID(),
    source: SocialSource = {
      projectId,
      documentId: randomUUID(),
      revisionId: randomUUID(),
      sourceHash: "a".repeat(64),
      variantId: randomUUID(),
      variantDigest: "b".repeat(64),
      templateId: "technical",
      templateVersion: "1",
      formatterVersion: "2",
      commit: "c".repeat(40),
    };
  let reviewed = true,
    permitted = true;
  const reference = async () => {
    await Promise.resolve();
    return {
      digest: source.variantDigest,
      source: {
        projectId,
        documentId: source.documentId,
        revisionId: source.revisionId,
        sourceHash: source.sourceHash,
        commit: source.commit,
      },
      review: reviewed ? { digest: source.variantDigest } : null,
    } as never;
  };
  const sources = mysqlFileSocialSources({
    variants: {
      capture: async () => {
        throw Error("unused");
      },
    },
    reference,
    queries: {
      record: async () => ({ spaceId, revisionId: source.revisionId, contentHash: source.sourceHash }) as never,
    },
    assets: {
      list: async () => [],
      content: async () => {
        throw Error("unused");
      },
    },
    spaces: {
      get: async () => {
        throw Error("unused");
      },
    },
    async requireProject() {
      await Promise.resolve();
      if (!permitted) throw Error("revoked");
    },
  });
  const guard = await sources.authorize("owner", source, projectId, spaceId);
  await guard();
  reviewed = false;
  await expect(guard()).rejects.toThrow("reviewRequired");
  reviewed = true;
  permitted = false;
  await expect(guard()).rejects.toThrow("revoked");
});
