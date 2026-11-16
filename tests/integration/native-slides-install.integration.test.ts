import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { nativeSlidesRegistryFixture } from "../support/native-slides-registry.js";
import { NativeSlidesTemplate } from "../../src/server/slides/templates/model.js";
import { captureNativeSlidesBundle } from "../../src/server/slides/templates/bundle.js";
import { nativeSlidesFixture } from "../support/native-slides.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { writeSourceZip } from "../../src/server/packages/zip/write.js";

const ref = (value: { id: string; version: string; digest: string }) => ({
  id: value.id,
  version: value.version,
  digest: value.digest,
});

for (const mode of ["archive", "file"] as const)
  test(`native raw ${mode} selection installs with the actual source provenance and no body in metadata`, async () => {
    const f = await nativeSlidesRegistryFixture();
    try {
      const original = await nativeSlidesFixture(),
        bytes =
          mode === "archive"
            ? original.original
            : await writeSourceZip([{ path: "decks/source.potx", bytes: original.original }]),
        captured = await captureSourceSnapshot(
          await openZipSource(bytes, mode === "archive" ? "source.potx" : "collection.zip"),
          undefined,
          bytes,
        ),
        staged = await f.stage(captured),
        api = f.service(),
        source = {
          id: staged.id,
          sha256: captured.digest,
          selection: mode === "archive" ? { kind: "archive" } : { kind: "file", path: "decks/source.potx" },
        },
        prepared = await api.prepare("owner", { source }),
        input = {
          source,
          definition: {
            settings: original.settings,
            mapping: original.mapping,
            licenseText: original.license,
            readmeText: original.readme,
          },
        };
      expect(prepared.definition).toBeNull();
      expect(api.snapshot("owner").templates).toEqual([]);
      const installed = await api.install("owner", { ...input, approval: await f.approve(api, input) }),
        selected = installed.current.templates[0]!;
      expect(selected.descriptor.importedFrom.selection.kind).toBe(mode);
      expect(selected.descriptor.importedFrom.digest).toBe(captured.digest);
      expect(selected.descriptor.manifest.original.sha256).toBe(original.presentation.index.source.sha256);
      expect(await api.with("owner", ref(selected), async (t) => t.original())).toEqual(original.original);
      const row = f.db.query<{ descriptor: string }, []>("SELECT descriptor FROM native_slides_versions").get()!;
      expect(row.descriptor).not.toContain(original.license.trim());
      expect(row.descriptor).not.toContain(original.readme.trim());
      expect(f.intake.ingestion.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
    } finally {
      await f.cleanup();
    }
  });

test("another process can observe a live install without failing or restarting its accepted work", async () => {
  const f = await nativeSlidesRegistryFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    let writes = 0;
    const api = f.service({
        bodies: (base) => ({
          ...base,
          async put(...args) {
            writes++;
            entered();
            await gate;
            return base.put(...args);
          },
        }),
      }),
      c = await f.command(),
      approval = await f.approve(api, c.input),
      command = { ...c.input, approval },
      pending = api.install("owner", command);
    await started;
    const other = f.service();
    await other.recover();
    expect(f.registry.operation("owner", approval.operationId)!.state).toBe("pending");
    await expect(other.install("owner", command)).rejects.toMatchObject({ code: "busy" });
    const stage = f.intake.templates.read("owner", c.staged.id);
    await f.intake.templates.remove("owner", stage.id, stage.revision);
    release();
    const result = await pending;
    expect(result.receipt.status).toBe("installed");
    expect(writes).toBe(1);
    expect(f.intake.ingestion.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
  } finally {
    release();
    await f.cleanup();
  }
});

test("native slide versions retain exact private files and receipts after intake cleanup and restart", async () => {
  const f = await nativeSlidesRegistryFixture();
  try {
    let api = f.service();
    const c = await f.command(),
      prepared = await api.prepare("owner", { source: c.input.source });
    expect(prepared.definition!.mapping).toEqual(c.mapping);
    const object = await api.part("owner", { source: c.input.source, part: prepared.original.layouts[0]!.path });
    expect(object.shapes[0]!.placeholder?.type).toBe("ctrTitle");
    const approval = await f.approve(api, c.input),
      command = { ...c.input, approval },
      installed = await api.install("owner", command),
      selected = installed.current.templates[0]!;
    expect(installed.receipt.status).toBe("installed");
    expect(selected.active).toBe(true);
    expect(selected.descriptor.importedFrom.origin).toEqual(c.captured.descriptor.origin);
    expect(api.snapshot("other").templates).toEqual([]);
    expect(() => api.detail("other", ref(selected))).toThrow("notFound");
    api.state("owner", ref(selected), "disable", installed.current.revision);
    expect(() => api.authorize("owner", ref(selected))).toThrow("disabled");
    const stage = f.intake.templates.read("owner", c.staged.id);
    await f.intake.templates.remove("owner", stage.id, stage.revision);
    expect((await api.install("owner", command)).current.templates[0]!.enabled).toBe(false);
    expect(await api.with("owner", ref(selected), async (template) => template.original())).toEqual(c.original);
    await f.restart();
    api = f.service();
    const replay = await api.install("owner", command);
    expect(replay.receipt).toEqual(installed.receipt);
    expect(replay.current.templates[0]!.enabled).toBe(false);
    expect(await api.with("owner", ref(selected), async (template) => template.mapping)).toEqual(c.mapping);
    expect(f.owned.templates.list("owner").filter((stage) => stage.state === "ready")).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("new native slide versions do not silently replace defaults and existing versions reject changed content", async () => {
  const f = await nativeSlidesRegistryFixture();
  try {
    const api = f.service(),
      first = await f.command(),
      a = await api.install("owner", { ...first.input, approval: await f.approve(api, first.input) }),
      second = await f.command("2.0.0"),
      b = await api.install("owner", { ...second.input, approval: await f.approve(api, second.input) });
    expect(b.current.templates.find((v) => v.version === "1.0.0")!.active).toBe(true);
    expect(b.current.templates.find((v) => v.version === "2.0.0")!.active).toBe(false);
    const selected = b.current.templates.find((v) => v.version === "2.0.0")!;
    api.state("owner", ref(selected), "activate", b.current.revision);
    expect(api.snapshot("owner").templates.find((v) => v.version === "2.0.0")!.active).toBe(true);
    const changed = await NativeSlidesTemplate.create(
        first.original,
        { ...first.settings, name: { en: "Different content" } },
        first.mapping,
        first.license,
        first.readme,
      ),
      capture = await captureNativeSlidesBundle(changed),
      stage = await f.stage(capture);
    await expect(
      api.review("owner", {
        source: { id: stage.id, sha256: capture.digest, selection: { kind: "bundle", root: "" } },
        definition: null,
      }),
    ).rejects.toMatchObject({ code: "immutableVersion" });
    expect(api.snapshot("owner").templates).toHaveLength(2);
    expect(a.receipt.id).toBe(selected.id);
  } finally {
    await f.cleanup();
  }
});

test("lost owned-file responses retain accepted install intent and recover without the intake source", async () => {
  const f = await nativeSlidesRegistryFixture();
  try {
    const broken = f.service({
        bodies: (base) => ({
          ...base,
          async put(...args) {
            await base.put(...args);
            throw Error("Simulated lost body response");
          },
        }),
      }),
      c = await f.command(),
      approval = await f.approve(broken, c.input),
      command = { ...c.input, approval };
    await expect(broken.install("owner", command)).rejects.toThrow("Simulated lost body response");
    expect(f.registry.operation("owner", approval.operationId)!.state).toBe("pending");
    const stage = f.intake.templates.read("owner", c.staged.id);
    await f.intake.templates.remove("owner", stage.id, stage.revision);
    await f.restart();
    const recovered = f.service();
    await recovered.recover();
    const result = await recovered.install("owner", command);
    expect(result.current.templates).toHaveLength(1);
    expect(result.receipt.operationId).toBe(approval.operationId);
    expect(
      await recovered.with("owner", ref(result.current.templates[0]!), async (template) => template.original()),
    ).toEqual(c.original);
    expect(f.owned.templates.list("owner").filter((stage) => stage.state === "ready")).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("stale registry revisions cannot publish an owned candidate and its orphan is removed", async () => {
  const f = await nativeSlidesRegistryFixture();
  try {
    const api = f.service(),
      first = await f.command(),
      installed = await api.install("owner", { ...first.input, approval: await f.approve(api, first.input) }),
      original = installed.current.templates[0]!,
      racing = f.service({
        bodies: (base) => ({
          ...base,
          async put(...args) {
            const result = await base.put(...args);
            f.registry.state(
              "owner",
              original.id,
              original.version,
              original.digest,
              "disable",
              installed.current.revision,
            );
            return result;
          },
        }),
      }),
      second = await f.command("2.0.0"),
      approval = await f.approve(racing, second.input);
    await expect(racing.install("owner", { ...second.input, approval })).rejects.toMatchObject({ code: "conflict" });
    expect(api.snapshot("owner").templates).toHaveLength(1);
    expect(api.snapshot("owner").templates[0]!.enabled).toBe(false);
    expect(f.registry.operation("owner", approval.operationId)!.state).toBe("failed");
    expect(f.owned.templates.list("owner").filter((stage) => stage.state === "ready")).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("duplicate install commands share accepted work and changed operation input cannot be replayed", async () => {
  const f = await nativeSlidesRegistryFixture();
  try {
    let writes = 0;
    const api = f.service({
        bodies: (base) => ({
          ...base,
          async put(...args) {
            writes++;
            return base.put(...args);
          },
        }),
      }),
      c = await f.command(),
      approval = await f.approve(api, c.input),
      command = { ...c.input, approval },
      [a, b] = await Promise.all([api.install("owner", command), api.install("owner", command)]);
    expect(a.receipt).toEqual(b.receipt);
    expect(writes).toBe(1);
    await expect(
      api.install("owner", { ...command, source: { ...command.source, sha256: "0".repeat(64) } }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(() =>
      api.install("owner", {
        ...command,
        approval: { ...approval, operationId: randomUUID(), licenseAcknowledged: false },
      }),
    ).toThrow("licenseNotAcknowledged");
    expect(api.snapshot("owner").templates).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("unknown missing-write outcomes have a recovery grace and capacity failures never install metadata", async () => {
  const f = await nativeSlidesRegistryFixture();
  try {
    const broken = f.service({
        bodies: (base) => ({
          ...base,
          async put() {
            throw Error("Unknown write outcome");
          },
        }),
      }),
      c = await f.command(),
      approval = await f.approve(broken, c.input);
    await expect(broken.install("owner", { ...c.input, approval })).rejects.toThrow("Unknown write outcome");
    expect(f.registry.operation("owner", approval.operationId)!.state).toBe("pending");
    f.advance(180001);
    await f.service().recover();
    expect(f.registry.operation("owner", approval.operationId)!.state).toBe("failed");
    expect(f.registry.operation("owner", approval.operationId)!.cleaned).toBe(true);
  } finally {
    await f.cleanup();
  }
  const small = await nativeSlidesRegistryFixture({ ownerBytes: 1, globalBytes: 1, ownerItems: 1, globalItems: 1 });
  try {
    const api = small.service(),
      c = await small.command(),
      approval = await small.approve(api, c.input);
    await expect(api.install("owner", { ...c.input, approval })).rejects.toMatchObject({ code: "storageFull" });
    expect(api.snapshot("owner").templates).toEqual([]);
    expect(small.registry.operation("owner", approval.operationId)!.state).toBe("failed");
    expect(small.owned.templates.list("owner")).toEqual([]);
  } finally {
    await small.cleanup();
  }
});
