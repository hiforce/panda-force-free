import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { CREATIVE_ASSET_LIMITS as limits } from "../../src/shared/creative/assets.js";
import { inspectWebBundle, prepareWebBundle, exportWebBundle } from "../../src/server/creative/assets/web-bundle.js";
import { readSourceZip } from "../../src/server/packages/zip/read.js";

const bytes = (text: string) => Buffer.from(text);
test("web bundle inventory is independent of transport order and preserves the chosen HTML and every resource", async () => {
  const files = {
      "site/home.html": bytes("<h1>Actual original</h1>"),
      "site/about.html": bytes("<h1>About</h1>"),
      "site/styles/base.css": bytes("body{color:navy}"),
      "site/images/插图.png": new Uint8Array([0, 1, 255]),
      "site/empty.css": new Uint8Array(),
    },
    archive = zipSync(files),
    inventory = await inspectWebBundle(archive);
  expect(inventory).toMatchObject({ schema: 1, files: 5, defaultEntry: null });
  expect(inventory.entries.map((entry) => entry.name)).toEqual(["site/about.html", "site/home.html"]);
  await expect(prepareWebBundle(archive, "index.html")).rejects.toMatchObject({ code: "invalidInput" });
  const selected = await prepareWebBundle(archive, "site/home.html");
  expect(selected.bytes).toEqual(files["site/home.html"]);
  expect(selected.resources.map((file) => file.name)).toEqual(
    Object.keys(files)
      .filter((name) => name !== selected.name)
      .sort(),
  );
  const exported = await readSourceZip(await exportWebBundle(selected));
  expect(exported.files.map((file) => file.path)).toEqual(Object.keys(files).sort());
  for (const [name, original] of Object.entries(files)) expect(exported.read(name)).toEqual(original);
  expect(
    (await inspectWebBundle(zipSync({ "index.html": bytes("Index"), "about.html": bytes("About") }))).defaultEntry,
  ).toBe("index.html");
  expect((await inspectWebBundle(zipSync({ "nested/only.html": bytes("One") }))).defaultEntry).toBe("nested/only.html");
});

test("web bundle admission rejects traversal, aliases, links, missing HTML and inflated resource limits", async () => {
  for (const input of [
    zipSync({ "../index.html": bytes("No") }),
    zipSync({ "index.html": bytes("Yes"), "A.css": bytes("a"), "a.css": bytes("b") }),
    zipSync({ "index.html": bytes("Yes"), "images/%2e%2e.png": bytes("No") }),
    zipSync({ "index.html": bytes("Yes"), "linked.css": [bytes("outside"), { attrs: (0o120777 << 16) >>> 0, os: 3 }] }),
    zipSync({ "readme.txt": bytes("No homepage") }),
    bytes("not a ZIP"),
  ])
    await expect(inspectWebBundle(input)).rejects.toMatchObject({ code: "invalidInput" });
  await expect(
    inspectWebBundle(zipSync({ "index.html": bytes("Yes"), "large.bin": new Uint8Array(limits.resourceBytes + 1) })),
  ).rejects.toMatchObject({ code: "tooLarge" });
  await expect(inspectWebBundle(zipSync({ "index.html": bytes("Yes") }), AbortSignal.abort())).rejects.toMatchObject({
    code: "unavailable",
  });
});
