import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { NativeThemeError } from "../../src/shared/templates/native/contracts.js";
import { nativeFiles, nativeSettings, nativeZipSource, nativeThemeFixture } from "../support/native-theme.js";
import { linkedSource } from "../support/linked-source.js";
import { deferred } from "../support/source-staging.js";

test("native installation owns exact original bytes and actor-scoped versions independently of cleaned intake and restarts", async () => {
  const f = await nativeThemeFixture(),
    { source, bytes } = await nativeZipSource();
  try {
    let service = f.service();
    const command = await f.command(service, source),
      installed = await service.install("owner", command.input),
      theme = installed.current.themes[0]!;
    expect(command.review.licenseText).toBe("MIT fixture license");
    expect(installed.receipt.status).toBe("installed");
    expect(service.snapshot("other")).toEqual({ revision: 0, themes: [] });
    expect(() => service.detail("other", { id: theme.id, version: theme.version, digest: theme.digest })).toThrow(
      "notFound",
    );
    service.state(
      "owner",
      { id: theme.id, version: theme.version, digest: theme.digest },
      "disable",
      installed.current.revision,
    );
    await f.intake.templates.remove("owner", command.stage.id, command.stage.revision);
    service = await f.restart();
    const replay = await service.install("owner", command.input),
      reference = { id: theme.id, version: theme.version, digest: theme.digest };
    expect(replay.receipt).toEqual(installed.receipt);
    expect(replay.current.themes[0]!.enabled).toBe(false);
    expect(() => service.authorize("owner", reference)).toThrow("disabled");
    await service.source("owner", reference, async (value) => {
      expect(value.source.readArchive()).toEqual(bytes);
      expect(value.source.tree.text("private.txt", 100)).toBe("Owner-only original resource");
      expect(value.projection.tree.read("source/logo.bin")).toEqual(new Uint8Array([0, 10, 255]));
    });
    expect(f.owned.ingestion.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
    await expect(
      service.install("owner", { ...command.input, settings: { ...command.input.settings, publisher: "Changed" } }),
    ).rejects.toThrow("conflict");
    const stored = f.db.query<{ descriptor: string }, []>("SELECT descriptor FROM native_theme_versions").get()!;
    expect(stored.descriptor).not.toContain("Owner-only original resource");
    expect(stored.descriptor).not.toContain("<h1>");
  } finally {
    await f.close();
  }
});

test("native approvals bind source root, exact settings, code permission and license acceptance; revisions and versions remain immutable", async () => {
  const f = await nativeThemeFixture(),
    { source } = await nativeZipSource();
  try {
    const service = f.service(),
      command = await f.command(service, source);
    for (const changed of [{ permissions: [] }, { licenseAcknowledged: false }])
      expect(() =>
        service.install("owner", { ...command.input, approval: { ...command.input.approval, ...changed } }),
      ).toThrow("executionNotApproved");
    await expect(
      service.install("owner", { ...command.input, settings: { ...command.input.settings, publisher: "Changed" } }),
    ).rejects.toThrow("reviewChanged");
    const first = await service.install("owner", command.input),
      second = await f.command(service, source, nativeSettings("2.0.0"));
    await service.install("owner", second.input);
    expect(service.snapshot("owner").themes.find((item) => item.version === "1.0.0")!.active).toBe(true);
    const current = service.snapshot("owner"),
      version = current.themes.find((item) => item.version === "2.0.0")!,
      ref = { id: version.id, version: version.version, digest: version.digest };
    expect(service.state("owner", ref, "activate", current.revision).active).toBe(true);
    expect(() => service.state("owner", ref, "disable", first.current.revision)).toThrow("conflict");
    await expect(
      service.review("owner", {
        source: command.input.source,
        settings: { ...nativeSettings(), publisher: "Changed" },
      }),
    ).rejects.toThrow("immutableVersion");
    const stale = await f.command(service, source, nativeSettings("3.0.0"));
    service.state("owner", ref, "disable", service.snapshot("owner").revision);
    await expect(service.install("owner", stale.input)).rejects.toThrow("reviewChanged");
    expect(service.snapshot("owner").themes).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("concurrent retries and recovery do not fail a live installation before its source reservation exists", async () => {
  const f = await nativeThemeFixture(),
    { source } = await nativeZipSource(),
    entered = deferred<void>(),
    release = deferred<void>();
  try {
    let writes = 0;
    const service = f.service({
        sources: (value) => ({
          ...value,
          async save(...args) {
            writes++;
            entered.resolve();
            await release.promise;
            return value.save(...args);
          },
        }),
      }),
      command = await f.command(service, source),
      pending = service.install("owner", command.input),
      duplicate = service.install("owner", command.input);
    await entered.promise;
    const other = f.service();
    await other.recover();
    expect(f.db.query<{ state: string }, []>("SELECT state FROM native_theme_operations").get()!.state).toBe("pending");
    await expect(other.install("owner", command.input)).rejects.toThrow("busy");
    await f.intake.templates.remove("owner", command.stage.id, command.stage.revision);
    release.resolve();
    expect((await duplicate).receipt).toEqual((await pending).receipt);
    expect(writes).toBe(1);
    expect(f.intake.ingestion.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
    expect(f.db.query("SELECT * FROM native_theme_versions").all()).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("restart recovery commits a frozen owned source after lost metadata acknowledgement without reading intake", async () => {
  const f = await nativeThemeFixture(),
    source = await linkedSource(nativeFiles, { "theme/source/alias.bin": "logo.bin" });
  try {
    const service = f.service({
        registry: (value) =>
          new Proxy(value, {
            get(target, key) {
              if (key === "commit")
                return () => {
                  throw new NativeThemeError("busy");
                };
              const member = Reflect.get(target, key);
              return typeof member === "function" ? member.bind(target) : member;
            },
          }),
      }),
      command = await f.command(service, source);
    await expect(service.install("owner", command.input)).rejects.toThrow("busy");
    expect(f.owned.templates.list("owner")[0]!.state).toBe("ready");
    await f.intake.templates.remove("owner", command.stage.id, command.stage.revision);
    const recovered = await f.restart();
    await recovered.recover();
    const installed = await recovered.install("owner", command.input),
      reference = { id: installed.receipt.id, version: installed.receipt.version, digest: installed.receipt.digest };
    await recovered.source("owner", reference, async (theme) => {
      expect(theme.source.digest).toBe(source.digest);
      expect(theme.source.links!.text("theme/source/alias.bin", 100)).toBe("logo.bin");
      expect(theme.projection.tree.read("source/alias.bin")).toEqual(new Uint8Array([0, 10, 255]));
    });
    expect(f.db.query("SELECT * FROM native_theme_versions").all()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("capacity and stale metadata failures clean owned reservations; interrupted intents expire without acquiring a fresh source", async () => {
  const f = await nativeThemeFixture({
      ownedCapacity: { ownerBytes: 1, globalBytes: 1, ownerItems: 1, globalItems: 1 },
    }),
    { source } = await nativeZipSource();
  try {
    const service = f.service(),
      command = await f.command(service, source);
    await expect(service.install("owner", command.input)).rejects.toThrow("storageFull");
    expect(f.db.query("SELECT state,cleaned FROM native_theme_operations").get()).toEqual({
      state: "failed",
      cleaned: 1,
    });
    expect(f.owned.templates.list("owner")).toEqual([]);
  } finally {
    await f.close();
  }
  const expired = await nativeThemeFixture();
  try {
    const service = expired.service({
        sources: (value) => ({
          ...value,
          async save() {
            throw new NativeThemeError("busy");
          },
        }),
      }),
      command = await expired.command(service, source);
    await expect(service.install("owner", command.input)).rejects.toThrow("busy");
    expired.advance(180001);
    await expired.service().recover();
    expect(expired.db.query("SELECT state,cleaned FROM native_theme_operations").get()).toEqual({
      state: "failed",
      cleaned: 1,
    });
    expect(expired.owned.templates.list("owner")).toEqual([]);
    await expect(expired.service().install("owner", command.input)).rejects.toThrow("conflict");
  } finally {
    await expired.close();
  }
});

test("new source ledgers expose operation lookup without crossing actor or template/skill purpose boundaries", async () => {
  const f = await nativeThemeFixture(),
    { source } = await nativeZipSource();
  try {
    const operationId = randomUUID(),
      origin = source.descriptor.origin;
    if (origin.kind !== "zip-upload") throw Error("Wrong source fixture");
    const stage = await f.intake.templates.submit("owner", operationId, {
      source: {
        kind: "zip-upload",
        name: origin.name,
        bytes: source.descriptor.archiveBytes,
        sha256: origin.archiveSha256,
      },
    });
    expect(f.intake.templates.operation("owner", operationId)!.id).toBe(stage.id);
    expect(f.intake.templates.operation("other", operationId)).toBeNull();
    expect(() => f.intake.skills.operation("owner", operationId)).toThrow("stageNotFound");
  } finally {
    await f.close();
  }
});

test("a registry revision change during source persistence releases the failed operation's owned disk reservation", async () => {
  const f = await nativeThemeFixture(),
    { source } = await nativeZipSource();
  try {
    const service = f.service(),
      first = await f.command(service, source),
      installed = await service.install("owner", first.input),
      theme = installed.current.themes[0]!,
      reference = { id: theme.id, version: theme.version, digest: theme.digest },
      racing = f.service({
        sources: (value) => ({
          ...value,
          async save(...args) {
            const saved = await value.save(...args);
            service.state("owner", reference, "disable", service.snapshot("owner").revision);
            return saved;
          },
        }),
      }),
      command = await f.command(racing, source, nativeSettings("2.0.0"));
    await expect(racing.install("owner", command.input)).rejects.toThrow("conflict");
    const sourceStage = f.owned.templates.operation("owner", command.input.approval.operationId)!;
    expect(sourceStage.state).toBe("removed");
    expect(sourceStage.reservedBytes).toBe(0);
    expect(service.snapshot("owner").themes).toHaveLength(1);
    expect(service.snapshot("owner").themes[0]!.enabled).toBe(false);
    expect(
      f.db
        .query("SELECT state,cleaned FROM native_theme_operations WHERE operationId=?")
        .get(command.input.approval.operationId),
    ).toEqual({ state: "failed", cleaned: 1 });
  } finally {
    await f.close();
  }
});

test("native shutdown drains accepted source reads before metadata closes and denies new admissions", async () => {
  const f = await nativeThemeFixture(),
    { source } = await nativeZipSource(),
    entered = deferred<void>(),
    release = deferred<void>();
  try {
    const service = f.service(),
      command = await f.command(service, source),
      installed = await service.install("owner", command.input),
      theme = installed.current.themes[0]!,
      pending = service.source(
        "owner",
        { id: theme.id, version: theme.version, digest: theme.digest },
        async (value) => {
          entered.resolve();
          await release.promise;
          return value.digest;
        },
      );
    await entered.promise;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    await expect(
      service.review("owner", { source: command.input.source, settings: command.input.settings }),
    ).rejects.toThrow("unavailable");
    expect(f.intake.ingestion.runtime.snapshot().active).toBe(1);
    release.resolve();
    expect(await pending).toBe(theme.digest);
    await closing;
    expect(closed).toBe(true);
    expect(f.intake.ingestion.runtime.snapshot().active).toBe(0);
  } finally {
    release.resolve();
    await f.close();
  }
});
