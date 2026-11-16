import { randomUUID } from "node:crypto";
import type { SocialAccounts, SocialSources } from "../../src/server/delivery/social/ports.js";
import type { WorkflowRecord } from "../../src/shared/delivery/workflow.js";
import { DeliveryError } from "../../src/server/delivery/errors.js";
import { createSocialPublicationFeature } from "../../src/server/delivery/integration/social-feature.js";
import { socialPublicationRoutes } from "../../src/server/delivery/integration/social-routes.js";
import { fileSocialSources } from "../../src/server/delivery/integration/file-social-sources.js";
import { routeSocialSources } from "../../src/server/delivery/integration/social-source-routing.js";
import { projectVariantFixture } from "./project-variant-fixture.js";

export async function projectSocialFixture(
  options: {
    now?: () => number;
    respond?: (
      path: string,
      body: Record<string, unknown> | undefined,
      method: string,
    ) => Promise<Record<string, unknown>>;
  } = {},
) {
  const t = await projectVariantFixture(),
    requests: { path: string; body: Record<string, unknown> | undefined; method: string }[] = [],
    state = { legacyCalls: 0, enabled: true, ioInTransaction: false, afterRecord: null as null | (() => void) },
    target = { id: randomUUID(), projectId: t.projectId, version: 1, accountId: "123", username: "isolated" };
  const noLegacy = () => {
    state.legacyCalls++;
    throw new DeliveryError("notFound", 404);
  };
  const legacy: SocialSources = {
    capture: noLegacy,
    authorize: noLegacy,
    space: noLegacy,
    readImage: async () => noLegacy(),
    article: noLegacy,
  };
  const reads = () => {
    state.ioInTransaction ||= t.db().inTransaction;
  };
  const sources = routeSocialSources(
    legacy,
    fileSocialSources({
      variants: {
        capture(id) {
          reads();
          return t.feature().variants.capture(id);
        },
      },
      reference: (id) => t.feature().variants.repository.files.reference(id),
      queries: {
        async record(...args) {
          reads();
          const result = await t.f.application().queries.record(...args);
          state.afterRecord?.();
          return result;
        },
      },
      assets: {
        list(...args) {
          reads();
          return t.f.application().assets.list(...args);
        },
        content(...args) {
          reads();
          return t.f.application().assets.content(...args);
        },
      },
      spaces: {
        get(...args) {
          reads();
          return t.f.application().spaces.get(...args);
        },
      },
      requireProject(id) {
        if (!t.f.grants.has(id)) throw new DeliveryError("notFound", 404);
      },
    }),
    (id) => t.feature().variants.repository.files.reference(id)?.source.projectId,
  );
  const accounts: SocialAccounts = {
    target(owner, id) {
      if (owner !== "owner" || id !== target.id) throw new DeliveryError("notFound", 404);
      return { ...target };
    },
    assert(owner, expected) {
      if (
        owner !== "owner" ||
        !state.enabled ||
        expected.accountId !== target.accountId ||
        expected.version !== target.version
      )
        throw new DeliveryError("authorizationChanged", 409);
    },
    async access(owner, expected) {
      accounts.assert(owner, expected);
      return {
        accessToken: "isolated-test",
        accountId: target.accountId,
        guard: () => accounts.assert(owner, expected),
      };
    },
  };
  function open() {
    const feature = createSocialPublicationFeature({
      db: t.db(),
      sources,
      accounts,
      now: options.now,
      transport: {
        async request(path, access, raw, method = "POST") {
          access.guard();
          const body = raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
          requests.push({ path, body, method });
          if (options.respond) return options.respond(path, body, method);
          if (path === "/2/media/upload") return { data: { id: "501", media_key: "3_501", expires_after_secs: 600 } };
          if (path === "/2/media/metadata") return { data: { id: body!.id } };
          if (path.endsWith("/draft")) return { data: { id: "601", title: body!.title } };
          if (path.endsWith("/publish")) return { data: { post_id: "701" } };
          return { data: { id: String(200 + requests.length), text: String(body?.text ?? "Confirmed") } };
        },
      },
    });
    t.routes.push(...socialPublicationRoutes(feature.service, () => "owner"));
    return feature;
  }
  let social = open();
  return {
    t,
    requests,
    state,
    target,
    sources,
    accounts,
    feature: () => social,
    async prepare(format = "x-post") {
      const current = await t.f.application().queries.record(t.projectId, t.documentId);
      const detail = (
        await t.f.call("/api/publication-variants", "POST", {
          projectId: t.projectId,
          documentId: t.documentId,
          revisionId: current.revisionId,
          mode: "format",
          format,
          templateId: "technical",
        })
      ).body;
      await t.feature().variants.review(
        detail.variant.id,
        {
          digest: detail.digest,
          acceptedIssues: detail.variant.issues.map(
            (issue: { blockId: string; code: string }) => issue.blockId + ":" + issue.code,
          ),
        },
        "reviewer",
      );
      return social.service.prepare("owner", {
        id: randomUUID(),
        variantId: detail.variant.id,
        connectionId: target.id,
      });
    },
    submit(record: WorkflowRecord, resume = false) {
      return social.service.submit("owner", {
        id: record.plan.id,
        kind: record.plan.kind,
        fingerprint: record.plan.fingerprint,
        acceptPlatformCosts: true,
        acceptPlatformEligibility: true,
        resume,
      });
    },
    async restart() {
      await social.stop();
      t.restart();
      social = open();
    },
    async close() {
      await social.stop();
      await t.close();
    },
  };
}
