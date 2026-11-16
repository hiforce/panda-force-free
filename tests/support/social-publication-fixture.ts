import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createTemporaryDirectory } from "./temporary-directory.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createPublishingFeature } from "../../src/server/publishing/integration/feature.js";
import { documentPublicationSources } from "../../src/server/publishing/integration/document-source.js";
import { socialSources } from "../../src/server/delivery/integration/social-sources.js";
import { createSocialPublicationFeature } from "../../src/server/delivery/integration/social-feature.js";
import { issueKey } from "../../src/server/publishing/variant-service.js";
import type { SocialAccounts } from "../../src/server/delivery/social/ports.js";
import { DeliveryError } from "../../src/server/delivery/errors.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import type { PublicationFormat } from "../../src/shared/publishing/content.js";
import type { WorkflowRecord } from "../../src/shared/delivery/workflow.js";

export async function socialFixture(
  content = "A reviewed paragraph.",
  options: {
    now?: () => number;
    respond?: (path: string, body: Record<string, unknown> | null, method: string) => Promise<Record<string, unknown>>;
  } = {},
) {
  const root = createTemporaryDirectory("panda-social-publish-", { preferMemory: true }),
    project = randomUUID();
  const documents = createDocumentFeature({
    stateRoot: root,
    allowedRoots: [root],
    requireProject(id) {
      if (id !== project) throw new Error("Missing project");
    },
  });
  const bridge = documentPublicationSources(documents.service, documents.assets);
  const publishing = createPublishingFeature(documents.persistence, bridge.sources, bridge.assets);
  const space = await documents.service.createSpace({
    projectId: project,
    code: "guide",
    name: "Guide",
    engine: "markdown",
    sourceMode: "managed",
    locale: "en",
  });
  let document = documents.service.createDocument({
    spaceId: space.id,
    path: "guide.md",
    title: "Guide",
    locale: "en",
    content,
  });
  const target = { id: randomUUID(), projectId: project, version: 1, accountId: "123", username: "fixture" };
  let enabled = true;
  const accounts: SocialAccounts = {
    target(owner, id) {
      if (owner !== "owner" || id !== target.id) throw new DeliveryError("notFound", 404);
      return { ...target };
    },
    assert(owner, value) {
      if (owner !== "owner" || !enabled || value.version !== target.version || value.accountId !== target.accountId)
        throw new DeliveryError("authorizationChanged", 409);
    },
    async access(owner, value) {
      accounts.assert(owner, value);
      return {
        accessToken: "fixture",
        accountId: target.accountId,
        guard() {
          accounts.assert(owner, value);
        },
      };
    },
  };
  const requests: { path: string; body: unknown }[] = [];
  let failure: "rejected" | "unknown" | null = null;
  const createFeature = () =>
    createSocialPublicationFeature({
      now: options.now,
      db: documents.persistence,
      sources: socialSources(documents.service, publishing.variants.repository, documents.assets),
      accounts,
      transport: {
        async request(path, access, body, method = "POST") {
          access.guard();
          requests.push({ path, body: body ? JSON.parse(body) : null });
          if (options.respond) return options.respond(path, body ? JSON.parse(body) : null, method);
          if (failure && requests.length === 2) throw new RemoteOperationError("platformUnavailable", failure);
          if (path.endsWith("/draft")) return { data: { id: "301", title: "Guide" } };
          if (path.endsWith("/publish")) return { data: { post_id: "401" } };
          return { data: { id: String(200 + requests.length), text: "Confirmed post" } };
        },
      },
    });
  let feature = createFeature();
  const variant = async (format: PublicationFormat, review = true) => {
    const result = await publishing.variants.prepare({
      documentId: document.document.id,
      revisionId: document.revision.id,
      format,
      mode: "format",
      templateId: "technical",
    });
    if (review)
      await publishing.variants.review(
        result.variant.id,
        { digest: result.digest, acceptedIssues: result.variant.issues.map(issueKey) },
        "reviewer",
      );
    return result;
  };
  const prepare = (id: string) =>
    feature.service.prepare("owner", { id: randomUUID(), variantId: id, connectionId: target.id });
  const submit = (record: WorkflowRecord, resume = false) =>
    feature.service.submit("owner", {
      id: record.plan.id,
      kind: record.plan.kind,
      fingerprint: record.plan.fingerprint,
      acceptPlatformCosts: true,
      acceptPlatformEligibility: true,
      resume,
    });
  return {
    documents,
    document,
    space,
    target,
    publishing,
    get feature() {
      return feature;
    },
    async restart() {
      await feature.stop();
      feature = createFeature();
    },
    save(content: string) {
      document = documents.service.saveDocument(document.document.id, {
        revision: document.document.revision,
        title: document.revision.title,
        locale: "en",
        content,
      });
      return document;
    },
    variant,
    prepare,
    submit,
    requests,
    fail: (value: typeof failure) => {
      failure = value;
    },
    disable: () => {
      enabled = false;
    },
    async dispose() {
      await feature.stop();
      documents.close();
      rmSync(root, { force: true, recursive: true });
    },
  };
}
