import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { creativeAssetRoutes } from "../../src/server/creative/assets/routes.js";
import type { Route } from "../../src/server/http/router.js";
import type { CreativeAssetKind } from "../../src/shared/creative/assets.js";
import { textPdf } from "../support/material-text.js";

async function fixture() {
  const routes: Route[] = [],
    f = await projectFileApiFixture({ extraRoutes: routes });
  routes.push(
    ...creativeAssetRoutes({
      owner: () => "operator:test-user",
      read: async () => f.application().creations,
      write: async () => f.application().creations,
    }),
  );
  return f;
}

test("real media and passive files retain their original bytes across HTTP preview, range, download, copy and restart", async () => {
  const f = await fixture();
  try {
    const png = await sharp({ create: { width: 48, height: 32, channels: 4, background: "#168c9b" } })
        .png()
        .toBuffer(),
      video = await readFile(new URL("../support/media/preview.mp4", import.meta.url)),
      values: { kind: CreativeAssetKind; name: string; bytes: Buffer; mime?: string }[] = [
        { kind: "image", name: "illustration.png", bytes: png, mime: "image/png" },
        { kind: "video", name: "clip.mp4", bytes: video, mime: "video/mp4" },
        {
          kind: "file",
          name: "notes.txt",
          bytes: Buffer.from("Original 中文 text. <script>neverExecute()</script>"),
          mime: "text/plain; charset=utf-8",
        },
        {
          kind: "file",
          name: "report.pdf",
          bytes: Buffer.from(textPdf({ text: "A complete portable original." })),
          mime: "application/pdf",
        },
        { kind: "file", name: "original.bin", bytes: Buffer.from([1, 0, 255, 13, 7]) },
      ];
    for (const input of values) {
      const id = "c-" + randomUUID(),
        q = new URLSearchParams({
          project: "project-1",
          id,
          operationId: randomUUID(),
          kind: input.kind,
          name: input.name,
          title: input.name,
          locale: "zh-CN",
        }),
        imported = await f.raw("/api/creative-assets/import?" + q, "POST", input.bytes),
        saved = await imported.json();
      expect(imported.status).toBe(201);
      expect(saved.asset.kind).toBe(input.kind);
      expect((await (await f.raw("/api/creative-assets/import?" + q, "POST", input.bytes)).json()).asset).toEqual(
        saved.asset,
      );
      const reference = new URLSearchParams({ project: "project-1", id, version: saved.asset.version });
      const detail = await f.call("/api/creative-assets/item?" + reference);
      expect(detail.status).toBe(200);
      if (input.name.endsWith("txt")) expect(detail.body.text).toContain("<script>");
      const download = await f.raw("/api/creative-assets/content?" + reference);
      expect(download.headers.get("content-disposition")).toStartWith("attachment;");
      expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(input.bytes));
      const view = await f.raw("/api/creative-assets/view?" + reference);
      expect(view.status).toBe(input.mime ? 200 : 400);
      if (input.mime) {
        expect(view.headers.get("content-type")).toBe(input.mime);
        expect(view.headers.get("content-security-policy")).toContain("sandbox");
        expect(view.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
        expect(view.headers.get("x-content-type-options")).toBe("nosniff");
        expect(Buffer.from(await view.arrayBuffer())).toEqual(Buffer.from(input.bytes));
        const head = await f.raw("/api/creative-assets/view?" + reference, "HEAD");
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe(String(input.bytes.length));
        expect((await head.arrayBuffer()).byteLength).toBe(0);
        const range = await f.raw("/api/creative-assets/view?" + reference, "GET", undefined, { range: "bytes=1-3" });
        expect(range.status).toBe(206);
        expect(range.headers.get("content-range")).toBe(`bytes 1-3/${input.bytes.length}`);
        expect(Buffer.from(await range.arrayBuffer())).toEqual(Buffer.from(input.bytes.subarray(1, 4)));
        if (input.kind === "video") {
          const suffix = await f.raw("/api/creative-assets/view?" + reference, "GET", undefined, { range: "bytes=-8" });
          expect(suffix.status).toBe(206);
          expect(Buffer.from(await suffix.arrayBuffer())).toEqual(Buffer.from(input.bytes.subarray(-8)));
          const changed = await f.raw("/api/creative-assets/view?" + reference, "GET", undefined, {
            range: "bytes=1-3",
            "if-range": '"another-version"',
          });
          expect(changed.status).toBe(200);
          expect(Buffer.from(await changed.arrayBuffer())).toEqual(Buffer.from(input.bytes));
        }
        const invalid = await f.raw("/api/creative-assets/view?" + reference, "GET", undefined, {
          range: "bytes=0-1,3-4",
        });
        expect(invalid.status).toBe(416);
        expect(invalid.headers.get("content-range")).toBe("bytes */" + input.bytes.length);
      }
      if (input.kind === "image") {
        const cover = await f.raw("/api/creative-assets/view?" + reference + "&variant=cover");
        expect(cover.status).toBe(200);
        expect(cover.headers.get("x-panda-image-width")).toBe("48");
        expect(cover.headers.get("x-panda-image-height")).toBe("32");
        expect(cover.headers.get("cache-control")).toBe("private, no-store");
        expect((await sharp(Buffer.from(await cover.arrayBuffer())).metadata()).format).toBe("webp");
      }
      const copy = await f.call("/api/creative-assets/copy", "POST", {
        project: "project-1",
        id,
        version: saved.asset.version,
        targetProject: "project-1",
        targetId: "c-" + randomUUID(),
        operationId: randomUUID(),
      });
      expect(copy.status).toBe(201);
      expect(copy.body.asset.source).toEqual(saved.asset.source);
      f.reopen();
      expect(Buffer.from(await (await f.raw("/api/creative-assets/content?" + reference)).arrayBuffer())).toEqual(
        Buffer.from(input.bytes),
      );
      expect(
        (
          await f.raw(
            "/api/creative-assets/view?" + new URLSearchParams({ project: "project-1", id, version: "0".repeat(64) }),
          )
        ).status,
      ).toBe(409);
    }
    const list = await f.call("/api/creative-assets?project=project-1");
    expect(list.body.assets).toHaveLength(values.length * 2);
  } finally {
    await f.close();
  }
}, 60000);

test("inline originals reject unauthorized, revoked, trashed and active-content requests without changing stored bytes", async () => {
  const f = await fixture();
  try {
    const id = "c-" + randomUUID(),
      bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
      q = new URLSearchParams({
        project: "project-1",
        id,
        operationId: randomUUID(),
        kind: "image",
        name: "private.png",
        title: "Private image",
        locale: "en",
      }),
      saved = await (await f.raw("/api/creative-assets/import?" + q, "POST", bytes)).json(),
      path =
        "/api/creative-assets/view?" + new URLSearchParams({ project: "project-1", id, version: saved.asset.version });
    expect((await fetch(f.base + path)).status).not.toBe(200);
    f.grants.delete("project-1");
    expect((await f.raw(path)).status).toBe(404);
    f.grants.add("project-1");
    await f.call("/api/creative-assets/availability", "POST", {
      project: "project-1",
      id,
      version: saved.asset.version,
      state: "trashed",
      operationId: randomUUID(),
    });
    expect((await f.raw(path)).status).toBe(404);
    const svg = "c-" + randomUUID(),
      source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>'),
      upload = await f.raw(
        "/api/creative-assets/import?" +
          new URLSearchParams({
            project: "project-1",
            id: svg,
            operationId: randomUUID(),
            kind: "file",
            name: "drawing.svg",
            title: "Original",
            locale: "en",
          }),
        "POST",
        source,
      ),
      value = await upload.json();
    expect(upload.status).toBe(201);
    const ref = new URLSearchParams({ project: "project-1", id: svg, version: value.asset.version });
    expect((await f.raw("/api/creative-assets/view?" + ref)).status).toBe(400);
    expect(Buffer.from(await (await f.raw("/api/creative-assets/content?" + ref)).arrayBuffer())).toEqual(source);
  } finally {
    await f.close();
  }
}, 60000);

test("unpreviewable originals remain downloadable while invalid media never acquires an image or video identity", async () => {
  const f = await fixture();
  try {
    for (const [kind, name, bytes, accepted] of [
      ["image", "forged.png", Buffer.from("not image bytes"), false],
      ["video", "forged.mp4", Buffer.from("not video bytes"), false],
      ["file", "private.constructor", Buffer.from("arbitrary preserved bytes"), true],
      ["file", "legacy.txt", Buffer.from([0xff, 0xfe, 0x80, 0x0]), true],
    ] as const) {
      const id = "c-" + randomUUID(),
        response = await f.raw(
          "/api/creative-assets/import?" +
            new URLSearchParams({
              project: "project-1",
              id,
              kind,
              name,
              title: name,
              operationId: randomUUID(),
              locale: "en",
            }),
          "POST",
          bytes,
        );
      expect(response.status).toBe(accepted ? 201 : 400);
      if (!accepted) continue;
      const saved = await response.json(),
        ref = new URLSearchParams({ project: "project-1", id, version: saved.asset.version });
      expect(Buffer.from(await (await f.raw("/api/creative-assets/content?" + ref)).arrayBuffer())).toEqual(bytes);
      if (name === "legacy.txt")
        expect((await f.call("/api/creative-assets/item?" + ref)).body.previewUnavailable).toBe(true);
      else expect((await f.raw("/api/creative-assets/view?" + ref)).status).toBe(400);
    }
  } finally {
    await f.close();
  }
}, 60000);
