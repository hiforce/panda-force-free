import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture } from "../support/app-fixture.mjs";
const fixture = await createAppFixture();
const artifacts = ".artifacts/social-publications-browser";
await mkdir(artifacts, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.signIn(context);
      const api = async (path, body, method = "post") => {
        if (path === "/api/projects" && body !== undefined && body.id === undefined) return fixture.legacyProject(body);
        const res = await context.request[method](fixture.base + path, { data: body });
        assert.ok(res.ok(), `${path}: ${res.status()} ${await res.text()}`);
        return res.json();
      };
      const catalog = await api("/api/projects", undefined, "get"),
        code = "social-" + width;
      const project = (
        await api("/api/projects", { code, name: "Publication studio", revision: catalog.revision })
      ).projects.find((p) => p.code === code);
      const { space } = await api("/api/document-spaces", {
        projectId: project.id,
        code: "guide",
        name: "Guide",
        engine: "markdown",
        sourceMode: "managed",
        locale: "en",
      });
      const doc = await api("/api/documents", {
        spaceId: space.id,
        path: "article.md",
        title: "A careful release",
        locale: "en",
        content: "A careful release keeps confirmed results. ".repeat(20),
      });
      const imageBytes = await sharp({ create: { width: 32, height: 20, channels: 3, background: "#4177aa" } })
        .png()
        .toBuffer();
      const assetResponse = await context.request.post(
        fixture.base + "/api/document-assets?document=" + doc.document.id + "&name=reviewed.png",
        { data: imageBytes, headers: { "content-type": "image/png" } },
      );
      assert.ok(assetResponse.ok());
      const { asset } = await assetResponse.json();
      await api(
        "/api/documents/detail?id=" + doc.document.id,
        {
          revision: doc.document.revision,
          title: doc.revision.title,
          locale: "en",
          content: doc.revision.content + `\n\n![Reviewed figure](/api/document-assets/content?id=${asset.id})`,
        },
        "put",
      );
      const account = {
        id: randomUUID(),
        projectId: project.id,
        name: "Fixture X account",
        provider: "x",
        enabled: true,
        version: 1,
        account: { id: "123", username: "fixture", name: "Fixture" },
        grant: {
          expiresAt: Date.now() + 7200000,
          scopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          credentialRevision: 1,
        },
        application: {
          clientId: "fixture",
          callbackUrl: fixture.base + "/api/publication-accounts/x/callback",
          confidential: false,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const page = await context.newPage(),
        errors = [],
        records = [],
        prepareIds = [],
        submissions = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("https://api.x.com/**", () => {
        throw Error("Browser must never publish to X directly");
      });
      await page.route("**/api/publication-accounts?*", (route) => route.fulfill({ json: { accounts: [account] } }));
      let loseReply = true,
        releaseMediaWait = false;
      await page.route("**/api/social-publications**", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.pathname.endsWith("/context")) return route.continue();
        if (url.pathname.endsWith("/detail")) {
          const publication = records.find((item) => item.plan.id === url.searchParams.get("id"));
          return route.fulfill({ json: { publication } });
        }
        if (request.method() === "GET") {
          for (const record of records)
            if (record.phase === "waiting" && releaseMediaWait) {
              record.phase = "failed";
              record.error = "rateLimited";
              record.updatedAt++;
            }
          return route.fulfill({ json: { publications: records.slice(0, 50) } });
        }
        const input = request.postDataJSON();
        if (url.pathname.endsWith("/successor")) {
          assert.equal(input.acceptContinuation, true);
          const parent = records.find((record) => record.plan.id === input.id);
          assert.equal(input.stateToken, parent.continuationToken);
          const child = structuredClone(parent);
          child.plan.id = input.successorId;
          child.plan.expiresAt = Date.now() + 86400000;
          child.plan.fingerprint = "e".repeat(64);
          child.phase = "prepared";
          child.error = null;
          child.cancellation = null;
          child.steps = [];
          child.resolutions = [];
          child.confirmations = [];
          child.recoveryEvidence = [];
          child.lineage = {
            predecessorId: parent.plan.id,
            successorId: null,
            rootId: parent.plan.id,
            depth: 1,
            confirmations: parent.confirmations.length,
            steps: parent.steps.map((step) => ({
              ...step,
              outcome: "succeeded",
              sourceJobId: parent.plan.id,
              result: parent.resolutions?.find((resolution) => resolution.stepId === step.id)?.result || step.result,
              resolution: parent.resolutions?.find((resolution) => resolution.stepId === step.id) || null,
            })),
            observations: [],
          };
          parent.lineage = { ...child.lineage, predecessorId: null, successorId: child.plan.id, steps: [] };
          records.unshift(child);
          return route.fulfill({ status: 201, json: { publication: child } });
        }
        if (url.pathname.endsWith("/recovery/inspect")) {
          assert.equal(input.acceptLookupCosts, true);
          const record = records.find((item) => item.plan.id === input.id);
          const evidence = {
            id: randomUUID(),
            stepId: input.stepId,
            actor: "fixture",
            fingerprint: record.plan.fingerprint,
            requestHash: "b".repeat(64),
            stateToken: "d".repeat(64),
            observedAt: Date.now(),
            expiresAt: Date.now() + 600000,
            status: "match",
            details: { remoteId: input.remoteId, text: "A matching existing Post" },
            result: { postId: input.remoteId, accountId: "123" },
          };
          record.recoveryEvidence = [evidence];
          return route.fulfill({ json: { evidence } });
        }
        if (url.pathname.endsWith("/recovery/adopt")) {
          assert.equal(input.acceptExistingResult, true);
          const record = records.find((item) => item.plan.id === input.id),
            evidence = record.recoveryEvidence[0];
          assert.equal(input.evidenceId, evidence.id);
          record.resolutions = [
            {
              stepId: evidence.stepId,
              evidenceId: evidence.id,
              actor: "fixture",
              decidedAt: Date.now(),
              decision: "adopt-existing",
              result: evidence.result,
            },
          ];
          record.phase = record.cancellation ? "cancelled" : "failed";
          record.error = null;
          return route.fulfill({ json: { publication: record } });
        }
        if (url.pathname.endsWith("/submit")) {
          assert.equal(input.acceptPlatformCosts, true);
          assert.equal(input.acceptPlatformEligibility, true);
          submissions.push(input);
          const record = records.find((item) => item.plan.id === input.id);
          record.confirmations.push({
            actor: "fixture",
            fingerprint: record.plan.fingerprint,
            createdAt: Date.now(),
            resume: input.resume,
            details: { acceptPlatformCosts: true, acceptPlatformEligibility: true, action: input.kind },
          });
          record.phase = record.plan.kind === "x-post" && !input.resume ? "waiting" : "completed";
          record.error = null;
          record.nextRunAt = record.phase === "waiting" ? Date.now() + 2000 : null;
          record.updatedAt++;
          if (record.plan.kind === "x-article-draft")
            record.receipt = { articleId: "301", accountId: "123", receivedAt: Date.now() };
          else
            record.receipt = {
              postId: "401",
              accountId: "123",
              url: "https://x.com/i/web/status/401",
              receivedAt: Date.now(),
            };
          record.steps = [
            {
              id: 1,
              key:
                record.plan.kind === "x-post"
                  ? "post.1"
                  : record.plan.kind === "x-article-publish"
                    ? "article.publish"
                    : "article.draft",
              operation: "fixture",
              attempt: 1,
              outcome: "succeeded",
              requestHash: "b".repeat(64),
              result: record.receipt,
              error: null,
              createdAt: Date.now(),
              completedAt: Date.now(),
            },
          ];
          if (record.phase === "waiting") {
            record.receipt = null;
            record.steps = [
              {
                ...record.steps[0],
                key: "media.m1.g1.upload",
                operation: "media.upload",
                result: { mediaId: "101", accountId: "123", state: "pending", expiresAt: Date.now() + 3600000 },
                replacedBy: null,
              },
            ];
          }
          return route.fulfill({ status: 202, json: { publication: record } });
        }
        if (url.pathname.endsWith("/article-publish")) {
          const draft = records.find((item) => item.plan.id === input.draftId);
          const payload = {
            adapterVersion: 2,
            source: draft.plan.payload.source,
            target: draft.plan.payload.target,
            draftJobId: draft.plan.id,
            articleId: "301",
            draft: draft.plan.payload.content.draft,
            media: draft.plan.payload.media,
            platformCosts: "unknown",
          };
          const record = {
            plan: { ...draft.plan, id: input.id, kind: "x-article-publish", payload, fingerprint: "c".repeat(64) },
            phase: "prepared",
            error: null,
            updatedAt: Date.now(),
            receipt: null,
            steps: [],
            confirmations: [],
          };
          records.unshift(record);
          return route.fulfill({ status: 201, json: { publication: record } });
        }
        if (url.pathname.endsWith("/cancel")) {
          const record = records.find((item) => item.plan.id === input.id);
          record.cancellation = { actor: "fixture", requestedAt: Date.now() };
          if (record.phase !== "running") record.phase = "cancelled";
          return route.fulfill({ json: { publication: record } });
        }
        prepareIds.push(input.id);
        let record = records.find((item) => item.plan.id === input.id);
        if (!record) {
          const variant = await api("/api/publication-variants/detail?id=" + input.variantId, undefined, "get");
          const value = variant.variant;
          record = {
            plan: {
              id: input.id,
              kind: value.format === "x-article" ? "x-article-draft" : "x-post",
              projectId: project.id,
              spaceId: space.id,
              connectionId: account.id,
              createdAt: Date.now(),
              expiresAt: Date.now() + 86400000,
              fingerprint: "a".repeat(64),
              payload: {
                adapterVersion: 2,
                platformCosts: "unknown",
                target: { id: account.id, projectId: project.id, version: 1, accountId: "123", username: "fixture" },
                source: {
                  ...value.source,
                  variantId: input.variantId,
                  variantDigest: variant.digest,
                  templateId: value.templateId,
                  templateVersion: value.templateVersion,
                  formatterVersion: value.formatterVersion,
                },
                media: (value.images || []).map((image, index) => ({
                  ...image,
                  key: `m${index + 1}`,
                  assetId: asset.id,
                  name: asset.name,
                  mime: asset.mime,
                  digest: asset.digest,
                  size: asset.size,
                })),
                content:
                  value.format === "x-article"
                    ? {
                        format: "x-article",
                        draft: {
                          title: value.title,
                          content_state: {
                            blocks: [{ key: "first", type: "unstyled", text: value.text }],
                            entities: [],
                          },
                        },
                      }
                    : {
                        format: value.format,
                        posts: value.posts.map((p) => p.text),
                        postMedia: value.posts.map((post) => (post.imageIndexes || []).map((index) => `m${index + 1}`)),
                      },
              },
            },
            phase: "prepared",
            error: null,
            updatedAt: Date.now(),
            receipt: null,
            steps: [],
            confirmations: [],
            observations: [],
            nextRunAt: null,
          };
          records.unshift(record);
        }
        if (loseReply) {
          loseReply = false;
          return route.abort("failed");
        }
        return route.fulfill({ status: 201, json: { publication: record } });
      });
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      await page.locator('[data-doc-action="publishing"]').click();
      const prepareVariant = async (format) => {
        const collapsed = await page.locator(".publishing-settings").getAttribute("data-collapsed");
        if (collapsed === "true") await page.locator('[data-pub-action="settings"]').click();
        await page.locator("#publicationFormat").selectOption(format);
        await page.locator('[data-pub-action="prepare"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-pub-action="prepare"]').disabled);
        assert.equal(await page.locator('[data-pub-action="publish"]').isDisabled(), true);
        for (const box of await page.locator("[data-issue]").all()) await box.check();
        await page.locator('[data-pub-action="review"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-pub-action="publish"]').disabled);
        await page.locator('[data-pub-action="publish"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-social-action="prepare"]').disabled);
      };
      await prepareVariant("x-thread");
      assert.equal(
        await page.locator(".social-layout").evaluate((el) => getComputedStyle(el).display),
        width === 1440 ? "grid" : "flex",
      );
      assert.equal(
        await page.locator("#socialWorkspace").evaluate((el) => getComputedStyle(el).paddingLeft),
        width === 1440 ? "28px" : "16px",
      );
      await page.locator('[data-social-action="prepare"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-social-action="prepare"]').disabled);
      await page.locator('[data-social-action="prepare"]').click();
      await page.locator('#socialPlan [data-phase="prepared"]').waitFor();
      await page.locator(".social-media img").waitFor();
      assert.equal(await page.locator(".social-media img").count(), 1);
      await page.locator(".social-media img").scrollIntoViewIfNeeded();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".social-media img")].every((image) => image.complete && image.naturalWidth > 0),
      );
      assert.equal(prepareIds[0], prepareIds[1]);
      assert.equal(records.length, 1);
      const confirm = async () => {
        assert.equal(await page.locator('[data-social-action="submit"]').isDisabled(), true);
        await page.locator("#socialAcceptCosts").check();
        assert.equal(await page.locator('[data-social-action="submit"]').isDisabled(), true);
        await page.locator("#socialAcceptEligibility").check();
        await page.locator('[data-social-action="submit"]').click();
      };
      await confirm();
      await page.locator('#socialPlan [data-phase="waiting"]').waitFor();
      assert.equal(await page.locator('[data-social-action="submit"]').count(), 0);
      assert.doesNotMatch(await page.locator("#socialPublicationDialog").innerText(), /social\.[a-zA-Z]+/);
      assert.match(await page.locator(".social-steps").innerText(), locale === "en" ? /Upload image 1/ : /上传图片 1/);
      await page.screenshot({ path: `${artifacts}/media-waiting-${engine.name()}.png` });
      releaseMediaWait = true;
      await page.locator('#socialPlan [data-phase="failed"]').waitFor();
      assert.ok((await page.locator("#socialJobError").innerText()).length > 10);
      await confirm();
      await page.locator('#socialPlan [data-phase="completed"]').waitFor();
      assert.equal(submissions.at(-1).resume, true);
      const links = page.locator(".social-steps a");
      assert.equal(await links.first().getAttribute("href"), "https://x.com/i/web/status/401");
      await page.locator('[data-social-action="close"]').click();
      await prepareVariant("x-article");
      await page.locator('[data-social-action="prepare"]').click();
      await page.locator('#socialPlan [data-phase="prepared"]').waitFor();
      await confirm();
      await page.locator('[data-social-action="article"]').waitFor();
      assert.equal(submissions.at(-1).kind, "x-article-draft");
      assert.equal(await page.locator(".social-steps a").count(), 0);
      await page.locator('[data-social-action="article"]').click();
      await page.locator('#socialPlan [data-phase="prepared"]').waitFor();
      await confirm();
      await page.locator('#socialPlan [data-phase="completed"]').waitFor();
      assert.equal(submissions.at(-1).kind, "x-article-publish");
      assert.doesNotMatch(await page.locator("#socialPublicationDialog").innerText(), /social\.[a-zA-Z]+/);
      const stopped = structuredClone(records.find((record) => record.plan.kind === "x-post"));
      stopped.plan.id = randomUUID();
      stopped.phase = "running";
      stopped.receipt = null;
      stopped.cancellation = null;
      stopped.steps[0].key = "post.1.g2";
      stopped.steps.push({
        ...stopped.steps[0],
        id: 2,
        key: "post.2",
        operation: "post.create",
        outcome: "pending",
        result: null,
        completedAt: null,
      });
      records.unshift(stopped);
      await page.locator('[data-social-action="refresh"]').click();
      await page.locator(`[data-social-action="select"][data-id="${stopped.plan.id}"]`).click();
      const beforeStop = submissions.length;
      const stop = page.locator('[data-social-action="cancel"]');
      assert.equal(await stop.innerText(), locale === "en" ? "Stop remaining steps" : "停止后续步骤");
      await stop.click();
      await page.locator(".social-stop-note").waitFor();
      assert.equal(await page.locator('[data-social-action="cancel"]').count(), 0);
      assert.equal(await page.locator('[data-social-action="submit"]').count(), 0);
      assert.match(
        await page.locator(".social-plan-heading").innerText(),
        locale === "en" ? /Stopping/ : /等待当前请求/,
      );
      assert.equal(
        await page.locator(".social-steps a").first().getAttribute("href"),
        "https://x.com/i/web/status/401",
      );
      stopped.phase = "needsAttention";
      stopped.error = "outcomeUnknown";
      await page.locator('[data-social-action="refresh"]').click();
      await page.locator('#socialPlan [data-phase="needsAttention"]').waitFor();
      assert.equal(await page.locator('[data-social-action="submit"]').count(), 0);
      assert.equal(submissions.length, beforeStop, "Stopping does not submit or retry a publication");
      assert.doesNotMatch(await page.locator("#socialPublicationDialog").innerText(), /social\.[a-zA-Z]+/);
      for (const size of width === 390 ? [320, 390, 768] : [1440]) {
        await page.setViewportSize({ width: size, height: 960 });
        assert.ok(
          await page.locator("#socialPublicationDialog").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        );
        const rect = await page.locator('[data-social-action="close"]').boundingBox();
        assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= size + 1);
      }
      await page.setViewportSize({ width, height: 960 });
      await page.screenshot({ path: `${artifacts}/publication-${engine.name()}.png` });
      await page.locator(".social-stop-note").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${artifacts}/stopped-unknown-${engine.name()}.png` });
      const recoverable = structuredClone(stopped);
      recoverable.plan.id = randomUUID();
      recoverable.cancellation = null;
      records.unshift(recoverable);
      await page.locator('[data-social-action="refresh"]').click();
      await page.locator(`[data-social-action="select"][data-id="${recoverable.plan.id}"]`).click();
      await page.locator(".social-recovery summary").click();
      const inspect = page.locator('[data-social-action="recovery-inspect"]');
      assert.equal(await inspect.isDisabled(), true);
      await page.locator("[data-recovery-id]").fill("402");
      await page.locator("[data-recovery-costs]").check();
      assert.equal(await inspect.isEnabled(), true);
      await inspect.click();
      await page.locator('[data-recovery-status="match"]').waitFor();
      const adopt = page.locator('[data-social-action="recovery-adopt"]');
      assert.equal(await adopt.isDisabled(), true);
      await page.locator("[data-recovery-accept]").check();
      await adopt.click();
      await page.locator(".social-recovery-adopted").waitFor();
      assert.equal(submissions.length, beforeStop, "Looking up and adopting never dispatches remaining steps");
      assert.equal(recoverable.steps.at(-1).outcome, "pending", "The original intent is not rewritten");
      assert.equal(
        await page.locator(".social-recovery-adopted a").getAttribute("href"),
        "https://x.com/i/web/status/402",
      );
      assert.equal(
        await page.locator('[data-social-action="submit"]').isDisabled(),
        true,
        "Resume still needs new confirmation",
      );
      await page.locator(".social-recovery-adopted").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${artifacts}/recovery-adopted-${engine.name()}.png` });
      assert.doesNotMatch(await page.locator("#socialPublicationDialog").innerText(), /social\.[a-zA-Z]+/);
      recoverable.plan.expiresAt = Date.now() - 1000;
      recoverable.continuationToken = "f".repeat(64);
      await page.locator('[data-social-action="refresh"]').click();
      await page.locator('[data-social-action="successor"]').waitFor();
      assert.equal(
        await page.locator('[data-social-action="submit"]').count(),
        0,
        "Expired plans require a new review",
      );
      await page.locator('[data-social-action="successor"]').click();
      await page.locator(".social-inherited-steps").waitFor();
      assert.equal(submissions.length, beforeStop, "Creating a continuation never submits it");
      assert.equal(await page.locator(".social-inherited-steps a").count(), 2);
      assert.equal(await page.locator('[data-social-action="submit"]').isDisabled(), true);
      assert.equal(await page.locator(".social-content article").first().locator(".social-inherited-note").count(), 1);
      await page.screenshot({ path: `${artifacts}/successor-${engine.name()}.png` });
      const childId = records[0].plan.id;
      // A related plan remains selectable when the recent-history window no longer includes it.
      for (let i = 0; i < 50; i++)
        records.unshift({ ...structuredClone(records[0]), plan: { ...records[0].plan, id: randomUUID() } });
      await page
        .locator(`.social-continuation [data-social-action="related"][data-id="${recoverable.plan.id}"]`)
        .click();
      await page.locator(`.social-continuation [data-id="${childId}"]`).waitFor();
      assert.equal(await page.locator('[data-social-action="submit"]').count(), 0);
      assert.equal(await page.locator('[data-social-action="cancel"]').count(), 0);
      await page.locator('[data-social-action="refresh"]').click();
      await page.locator(`.social-continuation [data-id="${childId}"]`).waitFor();
      await page.locator(`.social-continuation [data-id="${childId}"]`).click();
      await page.locator(".social-inherited-steps").waitFor();
      assert.doesNotMatch(await page.locator("#socialPlan").innerText(), /social\.[a-zA-Z]+/);
      assert.deepEqual(errors, []);
      console.log(
        engine.name() +
          ": reviewed content, lost response recovery, confirmation, partial retry, Article draft/publication and responsive UI passed",
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
