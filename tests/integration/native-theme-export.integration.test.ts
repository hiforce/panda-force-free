import { expect, test } from "bun:test";
import { nativeThemeFixture, nativeZipSource, nativeSettings } from "../support/native-theme.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { NativeSiteTheme } from "../../src/shared/templates/native/package.js";

test("private native export survives source cleanup and restart, and re-import needs a fresh explicit grant", async () => {
  const f = await nativeThemeFixture(),
    input = await nativeZipSource();
  let service = f.service();
  try {
    const command = await f.command(service, input.source),
      installed = await service.install("owner", command.input),
      original = installed.current.themes[0]!,
      ref = { id: original.id, version: original.version, digest: original.digest };
    await f.intake.templates.remove("owner", command.stage.id, command.stage.revision);
    service.state("owner", ref, "disable", installed.current.revision);
    service = await f.restart();
    const before = service.snapshot("owner"),
      file = await service.export("owner", ref, async (value) => value);
    expect(service.snapshot("owner")).toEqual(before);
    await expect(service.export("other", ref, async (value) => value)).rejects.toThrow("notFound");
    const reader = await openZipSource(file.bytes, file.filename),
      source = await captureSourceSnapshot(reader, undefined, file.bytes),
      stage = await f.stage(source, "recipient"),
      selection = { id: stage.id, sha256: stage.digest!, root: "theme" },
      proposal = await service.prepare("recipient", { source: selection, engine: "hexo" });
    expect(proposal.bundle?.themeDigest).toBe(original.digest);
    expect(proposal.settings.name).toEqual(nativeSettings().name);
    expect(proposal.licenseText).toBe("MIT fixture license");
    expect(service.snapshot("recipient").themes).toEqual([]);
    const next = await f.command(service, source, proposal.settings, "recipient");
    expect(() =>
      service.install("recipient", { ...next.input, approval: { ...next.input.approval, licenseAcknowledged: false } }),
    ).toThrow("executionNotApproved");
    const restored = await service.install("recipient", next.input),
      copy = restored.current.themes[0]!;
    expect(copy.enabled).toBe(true);
    expect(copy.digest).not.toBe(original.digest);
    expect(copy.descriptor.source.origin.kind).toBe("zip-upload");
    const oldTree = await service.source("owner", ref, async (theme) => theme.projection.tree.digest),
      newTree = await service.source(
        "recipient",
        { id: copy.id, version: copy.version, digest: copy.digest },
        async (theme) => theme.projection.tree.digest,
      );
    expect(newTree).toBe(oldTree);
    await expect(
      NativeSiteTheme.create(source, "theme", { ...proposal.settings, engine: "docusaurus", entry: "index.js" }),
    ).rejects.toThrow("invalidInput");
    const ownStage = await f.stage(source);
    await expect(
      service.review("owner", {
        source: { id: ownStage.id, sha256: ownStage.digest!, root: "theme" },
        settings: proposal.settings,
      }),
    ).rejects.toThrow("immutableVersion");
  } finally {
    await f.close();
  }
}, 30000);

test("native export holds its source lease through delivery and shutdown drains the accepted operation", async () => {
  const f = await nativeThemeFixture(),
    { source } = await nativeZipSource(),
    service = f.service();
  let release!: () => void, entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    const installed = await service.install("owner", (await f.command(service, source)).input),
      theme = installed.current.themes[0]!,
      exporting = service.export(
        "owner",
        { id: theme.id, version: theme.version, digest: theme.digest },
        async (value) => {
          entered();
          await gate;
          return value.filename;
        },
      );
    await arrived;
    expect(f.owned.ingestion.runtime.snapshot().active).toBe(1);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await exporting).toMatch(/\.native-theme\.zip$/);
    await closing;
    expect(f.owned.ingestion.runtime.snapshot().active).toBe(0);
    expect(closed).toBe(true);
  } finally {
    release();
    await f.close();
  }
}, 30000);
