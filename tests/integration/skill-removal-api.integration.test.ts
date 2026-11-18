import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillFeature } from "../../src/server/skills/integration/feature.js";
import { createRouter } from "../../src/server/http/router.js";
import { respondJson } from "../../src/server/http/respond.js";
import type { SkillPackDetail } from "../../src/shared/skills/registry.js";
import { nativeSkillPackage } from "../support/native-skill-package.js";

test("skill removal checks identity, origin and revision, replays safely, and preserves retained skills and immutable data", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-skill-removal-")),
    authorization = "Bearer isolated-skill-removal",
    owner = "operator:fixture";
  let feature = await createSkillFeature({ stateRoot: root, version: "0.0.14", owner: () => owner });
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== authorization) return respondJson(res, 401, { error: "Unauthorized" });
    const url = new URL(req.url!, "http://" + req.headers.host);
    if (!(await createRouter(feature.routes)({ req, res, url }))) respondJson(res, 404, { error: "Not found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected TCP address");
  const base = "http://127.0.0.1:" + address.port,
    call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization, origin: base, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  try {
    const retained = await feature.catalog.detail("panda-force.essentials", "1.0.0"),
      versions = [
        await nativeSkillPackage("example.prd-writer"),
        await nativeSkillPackage("example.prd-writer", "1.0.1"),
      ];
    for (const { pack } of versions) {
      const origin = { kind: "upload", name: "custom.skill.json", sha256: pack.digest },
        review = await feature.catalog.review(pack, origin, ["blog-outline"]);
      await feature.catalog.install(
        pack,
        origin,
        {
          id: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
          capabilities: review.capabilities,
        },
        owner,
      );
    }
    const removalPath = "/api/skill-packs/remove";
    expect((await fetch(base + removalPath, { method: "POST" })).status).toBe(401);
    for (const { pack } of versions) {
      const detail = await feature.catalog.detail(pack.manifest.id, pack.manifest.version),
        command = {
          operationId: randomUUID(),
          id: detail.package!.id,
          version: detail.package!.version,
          expectedRevision: detail.revision,
        };
      expect((await call(removalPath, command, { origin: "https://untrusted.example" })).status).toBe(403);
      expect((await call(removalPath, { ...command, actor: "forged" })).status).toBe(400);
      expect((await call(removalPath, { ...command, expectedRevision: command.expectedRevision - 1 })).status).toBe(
        409,
      );
      const response = await call(removalPath, command);
      expect(response.status).toBe(200);
      const removed = (await response.json()) as SkillPackDetail;
      expect(removed.package).toMatchObject({ removed: true, active: false, digest: pack.digest });
      expect(removed.package!.exports.every((entry) => !entry.enabled)).toBe(true);
      expect((await (await call(removalPath, command)).json()).revision).toBe(removed.revision);
      expect(
        (await call(removalPath, { ...command, operationId: randomUUID(), expectedRevision: removed.revision })).status,
      ).toBe(404);
      expect((await feature.catalog.export(pack.manifest.id, pack.manifest.version)).digest).toBe(pack.digest);
    }
    expect(
      (await feature.catalog.list(undefined, 100, true)).packages.some((pack) => pack.id === "example.prd-writer"),
    ).toBe(false);
    expect((await feature.catalog.detail("panda-force.essentials", "1.0.0")).package).toEqual(retained.package);
    feature.close();
    feature = await createSkillFeature({ stateRoot: root, version: "0.0.14", owner: () => owner });
    expect(
      (await feature.catalog.list(undefined, 100, true)).packages.some((pack) => pack.id === "example.prd-writer"),
    ).toBe(false);
    expect((await feature.catalog.detail("panda-force.essentials", "1.0.0")).package).toEqual(retained.package);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    feature.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
