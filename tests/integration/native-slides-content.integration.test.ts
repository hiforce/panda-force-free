import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPackageSourceStages } from "../../src/server/packages/staging/feature.js";
import { ownedStagedSources } from "../../src/server/packages/ownership/staged.js";
import { NativeSlidesContent } from "../../src/server/slides/templates/content.js";
import { nativeSlidesFixture } from "../support/native-slides.js";

test("native originals and mappings survive restart and are inaccessible to another actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-slides-owned-")),
    f = await nativeSlidesFixture(),
    operation = randomUUID();
  let env = createPackageSourceStages({ root });
  try {
    const first = new NativeSlidesContent(ownedStagedSources(env.templates, env.ingestion)),
      saved = await first.put("owner", operation, f.template);
    expect(await first.with("owner", saved, async (value) => value.original())).toEqual(f.original);
    await expect(
      first.with("owner", { ...saved, templateDigest: "0".repeat(64) }, async (value) => value.original()),
    ).rejects.toMatchObject({ code: "sourceChanged" });
    await expect(first.with("other", saved, async (value) => value.original())).rejects.toMatchObject({
      code: "stageNotFound",
    });
    expect(await first.recover("other", operation)).toBeNull();
    await env.close();
    env = createPackageSourceStages({ root });
    const reopened = new NativeSlidesContent(ownedStagedSources(env.templates, env.ingestion));
    expect(await reopened.recover("owner", operation)).toEqual(saved);
    expect(await reopened.put("owner", operation, f.template)).toEqual(saved);
    expect(await reopened.with("owner", saved, async (value) => value.mapping)).toEqual(f.mapping);
    expect(env.templates.list("owner")).toHaveLength(1);
    expect(env.templates.list("other")).toHaveLength(0);
  } finally {
    await env.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted native write whose response was lost recovers the original bytes and operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-slides-response-")),
    env = createPackageSourceStages({ root });
  try {
    const sources = ownedStagedSources(env.templates, env.ingestion),
      f = await nativeSlidesFixture(),
      operation = randomUUID(),
      content = new NativeSlidesContent({
        ...sources,
        async save(...args) {
          await sources.save(...args);
          throw new Error("Simulated lost response");
        },
      });
    await expect(content.put("owner", operation, f.template)).rejects.toThrow("Simulated lost response");
    const restored = new NativeSlidesContent(sources),
      recovered = await restored.recover("owner", operation);
    expect(recovered!.templateDigest).toBe(f.template.digest);
    expect(await restored.with("owner", recovered!, async (value) => value.original())).toEqual(f.original);
    expect(env.templates.list("owner")).toHaveLength(1);
  } finally {
    await env.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native source capacity is reserved before writing and source tampering fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-slides-capacity-")),
    small = createPackageSourceStages({
      root: join(root, "small"),
      capacity: { ownerBytes: 1, globalBytes: 1, ownerItems: 1, globalItems: 1 },
    }),
    normal = createPackageSourceStages({ root: join(root, "normal") });
  try {
    const f = await nativeSlidesFixture(),
      limited = new NativeSlidesContent(ownedStagedSources(small.templates, small.ingestion));
    await expect(limited.put("owner", randomUUID(), f.template)).rejects.toMatchObject({ code: "storageFull" });
    expect(small.templates.list("owner")).toEqual([]);
    const content = new NativeSlidesContent(ownedStagedSources(normal.templates, normal.ingestion)),
      saved = await content.put("owner", randomUUID(), f.template),
      path = join(root, "normal", "content", saved.source.id, saved.source.digest + ".source"),
      bytes = await readFile(path);
    expect(bytes.subarray(0, 8).toString()).toBe("PFSRC01\n");
    bytes[bytes.length - 1] = bytes.at(-1)! ^ 1;
    await writeFile(path, bytes);
    await expect(content.with("owner", saved, async (value) => value.original())).rejects.toThrow();
  } finally {
    await small.close();
    await normal.close();
    await rm(root, { recursive: true, force: true });
  }
});
