import { expect, test } from "bun:test";
import { nativeSlidesFixture } from "../support/native-slides.js";
import { nativeZipSource, nativeFiles } from "../support/native-theme.js";
import { captureNativeSlidesBundle } from "../../src/server/slides/templates/bundle.js";
import { discoverTemplateSource } from "../../src/server/templates/sources/discovery.js";
import { standardSourceProbes } from "../../src/server/templates/sources/probes.js";
import { officeSourceProbe } from "../../src/server/templates/integration/office-source-probe.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";

test("mixed libraries preserve distinct Office files in one folder, bundle roots and existing website candidates", async () => {
  const f = await nativeSlidesFixture(),
    bundle = await captureNativeSlidesBundle(f.template);
  const files = {
    ...nativeFiles,
    "decks/a.potx": f.original,
    "decks/b.potx": f.original,
    ...Object.fromEntries(bundle.tree.files.map((file) => ["managed/" + file.path, bundle.tree.read(file.path)])),
  };
  const source = await nativeZipSource(files),
    inspection = await discoverTemplateSource(source.source, [...standardSourceProbes, officeSourceProbe]);
  expect(
    (await discoverTemplateSource(source.source)).candidates.some((value) => value.kind.startsWith("powerpoint")),
  ).toBe(false);
  const candidates = inspection.candidates.filter((value) => value.kind.startsWith("powerpoint"));
  expect(candidates).toHaveLength(3);
  expect(candidates.map((value) => value.location)).toEqual(
    expect.arrayContaining([
      { kind: "file", path: "decks/a.potx" },
      { kind: "file", path: "decks/b.potx" },
      { kind: "directory", path: "managed" },
    ]),
  );
  expect(inspection.candidates.some((value) => value.kind === "hexo-theme")).toBe(true);
  const raw = await captureSourceSnapshot(await openZipSource(f.original, "original.potx"), undefined, f.original);
  expect((await discoverTemplateSource(raw, [officeSourceProbe])).candidates.map((value) => value.location)).toEqual([
    { kind: "archive" },
  ]);
});
