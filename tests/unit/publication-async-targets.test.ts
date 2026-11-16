import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTargets } from "../../src/server/connections/adapters/local-targets.js";
import { LocalSiteDelivery } from "../../src/server/delivery/adapters/local-site.js";
import { digest } from "../../src/server/delivery/digest.js";
import type { SitePublicationPlan } from "../../src/shared/delivery/contracts.js";

test("awaited target policy rejects a protected path before claim and rechecks before activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "publication-async-targets-"));
  try {
    let protectedRoots: string[] = [],
      lookups = 0,
      release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const denied = new LocalTargets([{ id: "local", path: root }], async () => {
      await blocked;
      return [root];
    });
    const pending = denied.claim(join(root, "blocked"), randomUUID());
    expect(await readdir(root)).toEqual([]);
    release();
    await expect(pending).rejects.toThrow("protectedPath");
    expect(await readdir(root)).toEqual([]);
    const targets = new LocalTargets([{ id: "local", path: root }], async () => {
      lookups++;
      await Promise.resolve();
      return protectedRoots;
    });
    const id = randomUUID(),
      connectionId = randomUUID(),
      projectId = randomUUID(),
      destination = join(root, "site"),
      content = Buffer.from("frozen"),
      now = Date.now();
    const plan: SitePublicationPlan = {
      id,
      connectionId,
      connectionVersion: 1,
      buildId: randomUUID(),
      projectId,
      spaceId: randomUUID(),
      fingerprint: digest("plan"),
      createdAt: now,
      expiresAt: now + 86400000,
      fileCount: 1,
      outputBytes: content.length,
      servedPath: join(destination, "current"),
      connection: {
        id: connectionId,
        projectId,
        connector: "local-site",
        name: "Fixture",
        root: "local",
        directory: "site",
        publicUrl: "https://example.com/",
        version: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      build: {
        id: randomUUID(),
        site: { title: "Fixture", url: "https://example.com", basePath: "/", locale: "en" },
        engine: "hexo",
        inputHash: digest("input"),
        sources: [],
        image: null,
      },
    };
    const artifact = {
      protocol: 1 as const,
      bytes: content.length,
      files: [{ path: "index.html", data: content.toString("base64"), sha256: digest(content) }],
    };
    await expect(
      new LocalSiteDelivery(targets).deliver(plan, artifact, {
        fence: 1,
        run(step, operation) {
          if (step === "activating") protectedRoots = [destination];
          return operation();
        },
        async remote() {
          throw Error("unexpected remote operation");
        },
      }),
    ).rejects.toThrow("protectedPath");
    expect(lookups).toBeGreaterThan(3);
    await expect(access(plan.servedPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
