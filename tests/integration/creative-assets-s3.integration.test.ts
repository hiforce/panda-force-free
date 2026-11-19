import { decodeCreativeAsset } from "../../src/server/creative/assets/codec.js";
import { projectCreationFile } from "../../src/server/project-content/paths.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { objectStorageFixture } from "../support/object-storage-fixture.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { OriginalStorageConfiguration } from "../../src/server/object-storage/configuration.js";
import { PrivateStorageFiles } from "../../src/server/object-storage/private-files.js";
import { OriginalObjectStorage } from "../../src/server/object-storage/originals.js";
import { PrivateS3Client } from "../../src/server/object-storage/s3.js";
import { CreativeAssetPurges } from "../../src/server/creative/assets/purge.js";
import { creativeAssetRoutes } from "../../src/server/creative/assets/routes.js";
import { projectCreationHtml } from "../../src/server/project-content/paths.js";
import type { Route } from "../../src/server/http/router.js";

const run = process.env.PANDA_FORCE_TEST_MINIO_IMAGE ? test : test.skip;
run(
  "real S3 application originals use private metadata and ranges, preserve trash and clear all remote history only after a committed permanent delete",
  async () => {
    const s3 = await objectStorageFixture();
    if (!s3) throw new Error("No owned S3 fixture");
    const directory = await mkdtemp(join(tmpdir(), "panda-application-originals-"));
    let clock = Date.now(),
      puts = 0,
      gets = 0,
      deletes = 0,
      denyDelete = false;
    const ranges: (string | null)[] = [];
    let ioCheck: (() => Promise<void>) | undefined;
    class Configuration extends OriginalStorageConfiguration {
      override async client(id: string, digest?: string) {
        const value = await super.client(id, digest);
        return {
          ...value,
          client: new PrivateS3Client(value.profile, s3!.credentials, async (url, options) => {
            if (options.method === "PUT") puts++;
            if (options.method === "GET") {
              gets++;
              ranges.push(new Headers(options.headers).get("range"));
            }
            if (options.method === "DELETE") {
              deletes++;
              if (denyDelete) return new Response(null, { status: 403 });
            }
            await ioCheck?.();
            return fetch(url, options);
          }),
        };
      }
    }
    const configuration = new Configuration(new PrivateStorageFiles(join(directory, "private"))),
      objects = new OriginalObjectStorage(
        configuration,
        () => true,
        () => clock,
      ),
      routes: Route[] = [];
    let purges!: CreativeAssetPurges;
    const ports = { objects, purges: null as unknown as CreativeAssetPurges };
    const f = await projectFileApiFixture({
      extraRoutes: routes,
      originalStorage: (root) => {
        ports.purges = purges = new CreativeAssetPurges(objects, [root]);
        return ports;
      },
    });
    routes.push(
      ...creativeAssetRoutes({
        owner: () => "operator:test-user",
        read: async () => f.application().creations,
        write: async () => f.application().creations,
      }),
    );
    try {
      const bucket = "panda-application-" + randomUUID(),
        created = await s3.request("PUT", "/" + bucket);
      expect(created.status).toBe(200);
      await created.body?.cancel();
      await configuration.save({
        action: "configure",
        revision: 0,
        operationId: randomUUID(),
        mode: "s3",
        kinds: ["image", "video", "web"],
        profile: {
          ...s3.connection(bucket),
          label: "Private application originals",
          prefix: "originals",
          credentials: s3.credentials,
        },
      });
      ioCheck = async () => {
        const check = f.application().projectContent.view("project-1", async () => true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          expect(
            await Promise.race([
              check,
              new Promise<boolean>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Project Git lease held during object IO")), 2000);
              }),
            ]),
          ).toBe(true);
        } finally {
          clearTimeout(timer);
        }
      };
      const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: "#168c9b" } })
          .png()
          .toBuffer(),
        imageInput = {
          id: "c-" + randomUUID(),
          operationId: randomUUID(),
          expectedVersion: null,
          kind: "image" as const,
          title: "Private illustration",
          locale: "en",
          name: "illustration.png",
          bytes: png,
        },
        saved = await f.application().creations.save("alice", "project-1", imageInput);
      expect(saved.asset).toMatchObject({ originalStore: "object", hasObjectHistory: true, state: "saved" });
      const initialPuts = puts;
      expect(await f.application().creations.save("alice", "project-1", imageInput)).toEqual(saved);
      expect(puts).toBe(initialPuts);
      const q = new URLSearchParams({ project: "project-1", id: saved.asset.id, version: saved.asset.version }),
        beforeDetail = gets;
      expect((await f.call("/api/creative-assets/item?" + q)).status).toBe(200);
      expect(gets).toBe(beforeDetail);
      const firstLink = await f.call("/api/creative-assets/link?" + q);
      expect(firstLink.status).toBe(200);
      expect(new URL(firstLink.body.url).origin).toBe(s3.endpoint);
      expect(new URL(firstLink.body.url).searchParams.get("X-Amz-Expires")).toBe("86400");
      expect(firstLink.body.expiresAt - Date.now()).toBeGreaterThan(86300000);
      const repeatedLinks = await Promise.all(
        Array.from({ length: 6 }, () => f.call("/api/creative-assets/link?" + q)),
      );
      for (const link of repeatedLinks) expect(link.body).toEqual(firstLink.body);
      clock += 3600000;
      expect((await f.call("/api/creative-assets/link?" + q)).body).toEqual(firstLink.body);
      clock = Date.now();
      expect(gets).toBe(beforeDetail);
      const direct = await fetch(firstLink.body.url);
      expect(direct.status).toBe(200);
      expect(Buffer.from(await direct.arrayBuffer())).toEqual(png);
      expect(gets).toBe(beforeDetail);
      f.grants.delete("project-1");
      expect((await f.call("/api/creative-assets/link?" + q)).status).toBe(404);
      f.grants.add("project-1");
      const parallelDetails = await Promise.all(
        Array.from({ length: 6 }, () => f.call("/api/creative-assets/item?" + q)),
      );
      expect(parallelDetails.map((value) => value.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(gets).toBe(beforeDetail);
      const range = await f.raw("/api/creative-assets/view?" + q, "GET", undefined, { range: "bytes=2-7" });
      expect(range.status).toBe(206);
      expect(Buffer.from(await range.arrayBuffer())).toEqual(png.subarray(2, 8));
      expect(range.headers.get("content-range")).toBe(`bytes 2-7/${png.length}`);
      expect(gets).toBe(beforeDetail);
      const beforeHead = gets,
        head = await f.raw("/api/creative-assets/view?" + q, "HEAD");
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(png.length));
      expect(gets).toBe(beforeHead);
      const beforeCovers = gets,
        beforeCoverPuts = puts;
      const covers = await Promise.all(
        Array.from({ length: 6 }, () => f.raw("/api/creative-assets/view?" + q + "&variant=cover")),
      );
      for (const cover of covers) {
        expect(cover.status).toBe(200);
        expect(cover.headers.get("content-type")).toBe("image/webp");
        expect(cover.headers.get("cache-control")).toBe("private, no-store");
        expect((await sharp(Buffer.from(await cover.arrayBuffer())).metadata()).width).toBe(24);
      }
      expect(gets).toBe(beforeCovers + 1);
      expect(puts).toBe(beforeCoverPuts);
      const invalid = await f.raw("/api/creative-assets/view?" + q, "GET", undefined, { range: "bytes=999999-" });
      expect(invalid.status).toBe(416);
      expect(gets).toBe(beforeCovers + 1);
      const copy = await f
        .application()
        .creations.copyFrom(
          f.application().creations,
          "alice",
          { project: "project-1", id: saved.asset.id, version: saved.asset.version },
          "project-1",
          "c-" + randomUUID(),
          randomUUID(),
        );
      const copyQ = new URLSearchParams({ project: "project-1", id: copy.asset.id, version: copy.asset.version }),
        copyLink = await f.call("/api/creative-assets/link?" + copyQ);
      clock += 86400000;
      const renewedLink = await f.call("/api/creative-assets/link?" + copyQ);
      expect(renewedLink.body.url).not.toBe(copyLink.body.url);
      expect(renewedLink.body.expiresAt).toBeGreaterThan(copyLink.body.expiresAt);
      clock = Date.now();
      const trashed = await f
        .application()
        .creations.setState("alice", "project-1", saved.asset.id, saved.asset.version, "trashed", randomUUID());
      expect(deletes).toBe(0);
      expect((await f.call("/api/creative-assets/item?" + q)).status).toBe(404);
      expect((await f.call("/api/creative-assets/link?" + q)).status).toBe(404);
      const retainedLink = await fetch(firstLink.body.url);
      expect(retainedLink.status).toBe(200);
      await retainedLink.body?.cancel();
      expect((await f.raw("/api/creative-assets/view?" + q + "&variant=cover")).status).toBe(404);
      const restored = await f
        .application()
        .creations.setState("alice", "project-1", saved.asset.id, trashed.asset.version, "saved", randomUUID());
      expect((await f.application().creations.original("project-1", saved.asset.id)).bytes).toEqual(png);
      const next = await sharp({ create: { width: 24, height: 16, channels: 4, background: "#8c169b" } })
          .png()
          .toBuffer(),
        revised = await f.application().creations.save("alice", "project-1", {
          ...imageInput,
          operationId: randomUUID(),
          expectedVersion: restored.asset.version,
          bytes: next,
        });
      expect(revised.asset.previousVersion).toBe(restored.asset.version);
      const web = await f.application().creations.save("alice", "project-1", {
        id: "c-" + randomUUID(),
        operationId: randomUUID(),
        expectedVersion: null,
        kind: "web",
        title: "Private web",
        locale: "en",
        name: "index.html",
        bytes: Buffer.from("<h1>Private source</h1>"),
        resources: [{ name: "own.png", bytes: png }],
      });
      expect(await f.snapshots.fileAt(web.commit, projectCreationHtml(web.asset.id))).toBeNull();
      expect((await f.application().creations.read("project-1", web.asset.id, undefined, true)).previewHtml).toContain(
        "Private source",
      );
      expect((await f.application().originals.current("project-1", [web.asset.id], ["web"]))[0]?.text).toContain(
        "Private source",
      );
      const beforeResource = gets,
        webQ = new URLSearchParams({
          project: "project-1",
          id: web.asset.id,
          version: web.asset.version,
          resource: "own.png",
        }),
        resource = await f.raw("/api/creative-assets/content?" + webQ);
      expect(Buffer.from(await resource.arrayBuffer())).toEqual(png);
      expect(gets - beforeResource).toBe(0);
      const video = await readFile(new URL("../support/media/preview.mp4", import.meta.url)),
        movie = await f.application().creations.save("alice", "project-1", {
          id: "c-" + randomUUID(),
          operationId: randomUUID(),
          expectedVersion: null,
          kind: "video",
          title: "Video",
          locale: "en",
          name: "clip.mp4",
          bytes: video,
        });
      const movieQ = new URLSearchParams({ project: "project-1", id: movie.asset.id, version: movie.asset.version }),
        movieRange = await f.raw("/api/creative-assets/view?" + movieQ, "GET", undefined, { range: "bytes=-16" });
      expect(Buffer.from(await movieRange.arrayBuffer())).toEqual(video.subarray(-16));
      expect(movieRange.headers.get("content-range")).toBe(
        `bytes ${video.length - 16}-${video.length - 1}/${video.length}`,
      );

      const trash = await f
          .application()
          .creations.setState("alice", "project-1", revised.asset.id, revised.asset.version, "trashed", randomUUID()),
        deletion = {
          project: "project-1",
          id: trash.asset.id,
          version: trash.asset.version,
          operationId: randomUUID(),
        };
      denyDelete = true;
      const requested = await f.call("/api/creative-assets/permanent-delete", "POST", deletion);
      expect(requested.status).toBe(202);
      expect(requested.body.asset.state).toBe("purging");
      expect(
        decodeCreativeAsset((await f.snapshots.fileAt(requested.body.commit, projectCreationFile(trash.asset.id)))!)
          .version,
      ).toBe(requested.body.asset.version);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = await f.application().creations.purgeStatus("project-1", trash.asset.id);
      expect(state.asset.state).toBe("purging");
      expect(state.status.state).toBe("pending");
      await expect(
        f
          .application()
          .creations.setState("alice", "project-1", trash.asset.id, state.asset.version, "saved", randomUUID()),
      ).rejects.toMatchObject({ code: "storageConflict" });
      expect(
        (await f.application().creations.list("project-1", undefined, "trashed")).assets.some(
          (asset) => asset.id === trash.asset.id && asset.state === "purging",
        ),
      ).toBe(true);
      const replay = await f.call("/api/creative-assets/permanent-delete", "POST", deletion);
      expect(replay.status).toBe(202);
      expect(replay.body.asset.purge.operationId).toBe(deletion.operationId);
      await purges.retry(f.owned, state.asset);
      denyDelete = false;
      ioCheck = undefined;
      f.grants.delete("project-1");
      // The committed deletion capability survives membership revocation without granting any new read or write authority.
      expect(await purges.retry(f.owned, state.asset)).toEqual({ state: "complete" });
      expect((await f.call("/api/creative-assets/item?" + q)).status).toBe(404);
      f.grants.add("project-1");
      f.reopen();
      const finished = await f.application().creations.purgeStatus("project-1", trash.asset.id);
      expect(finished.asset.state).toBe("purged");
      expect(finished.status.state).toBe("complete");
      const removedLink = await fetch(firstLink.body.url);
      expect(removedLink.status).toBe(404);
      await removedLink.body?.cancel();
      expect((await f.application().creations.original("project-1", copy.asset.id)).bytes).toEqual(png);
      await expect(f.application().creations.save("alice", "project-1", imageInput)).rejects.toMatchObject({
        code: "storageConflict",
      });
      expect(
        (await f.application().creations.list("project-1", undefined, "trashed")).assets.some(
          (asset) => asset.id === trash.asset.id,
        ),
      ).toBe(false);
      expect((await f.application().creations.original("project-1", movie.asset.id)).bytes).toEqual(video);
      const abandoned = await f
          .application()
          .creations.setState("alice", "project-1", web.asset.id, web.asset.version, "trashed", randomUUID()),
        originalOperation = randomUUID();
      const reserved = await f
          .application()
          .projectContent.view("project-1", () => purges.reserve(f.owned, abandoned.asset, originalOperation)),
        beforeUncommitted = deletes;
      expect(await purges.run(reserved.id)).toEqual({ state: "pending" });
      expect(deletes).toBe(beforeUncommitted);
      denyDelete = true;
      const resumed = await f
        .application()
        .creations.permanentDelete("alice", "project-1", abandoned.asset.id, abandoned.asset.version, randomUUID());
      expect(resumed.asset.purge?.operationId).toBe(originalOperation);
      expect((await purges.retry(f.owned, resumed.asset)).state).toBe("pending");
      await purges.close();
      ports.purges = purges = new CreativeAssetPurges(objects, [f.root]);
      denyDelete = false;
      f.reopen();
      purges.start();
      const deadline = Date.now() + 10000;
      while ((await f.application().creations.purgeStatus("project-1", abandoned.asset.id)).asset.state !== "purged") {
        if (Date.now() > deadline) throw new Error("Restarted cleanup worker did not finish a committed job");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await f.application().creations.purgeStatus("project-1", abandoned.asset.id)).status.state).toBe(
        "complete",
      );
    } finally {
      ioCheck = undefined;
      await f.close();
      await s3.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
