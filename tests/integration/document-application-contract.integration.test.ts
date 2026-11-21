import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createMySQLDocumentFeature } from "../../src/server/documents/mysql-feature.js";
import { createRouter } from "../../src/server/http/router.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";
import { createTemporaryDirectory } from "../support/temporary-directory.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

for (const backend of ["sqlite", "mysql"] as const)
  test.skipIf(backend === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${backend} document HTTP contract retains revisions, authorization, private assets and request boundaries`,
    async () => {
      const root = createTemporaryDirectory("panda-document-contract-", { preferMemory: true });
      const mysql = backend === "mysql" ? await isolatedMySQLDatabase("docroute") : null;
      if (mysql)
        await new DatabaseRegistry().register(mysqlDocumentsModule).upgrade(new MySQLSchemaConnection(mysql.sql));
      let permitted = true;
      const options = {
        stateRoot: join(root, "state"),
        allowedRoots: [root],
        requireProject(project: string) {
          if (!permitted || project !== "project") throw new DocumentError("notFound", 404);
        },
      };
      const feature = mysql
        ? createMySQLDocumentFeature({ ...options, sql: mysql.sql })
        : createDocumentFeature(options);
      const keys = feature.routes.flatMap((route) =>
        (Array.isArray(route.method) ? route.method : [route.method]).map((method) => `${route.path}:${method}`),
      );
      expect(new Set(keys).size).toBe(keys.length);
      const dispatch = createRouter(feature.routes);
      const server = createServer((req, res) => {
        void dispatch({ req, res, url: new URL(req.url!, `http://${req.headers.host}`) }).then((handled) => {
          if (!handled) res.writeHead(404).end();
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Fixture did not listen");
      const base = `http://127.0.0.1:${address.port}`;
      const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
        fetch(base + path, {
          method,
          headers: {
            origin: base,
            connection: "close",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const json = async (path: string, body?: unknown, method?: string) => {
        const response = await request(path, body, method);
        expect(response.ok, await response.clone().text()).toBe(true);
        return response.json();
      };
      try {
        const { space } = await json("/api/document-spaces", {
          projectId: "project",
          code: "guide",
          name: "Guide",
          engine: "markdown",
          sourceMode: "managed",
          locale: "en",
        });
        expect((await json("/api/document-spaces?project=project")).spaces.map((s: { id: string }) => s.id)).toEqual([
          space.id,
        ]);
        const first = await json("/api/documents", {
          spaceId: space.id,
          path: "guide.md",
          title: "Guide",
          content: "Original",
          locale: "en",
        });
        const id = first.document.id;
        expect((await json(`/api/documents?space=${space.id}`)).total).toBe(1);
        const detail = await request(`/api/documents/detail?id=${id}`);
        expect(await detail.json()).toEqual(first);
        expect(detail.headers.get("vary")).toContain("Accept-Encoding");
        const saved = await json(
          `/api/documents/detail?id=${id}`,
          { title: "Updated", content: "Retained update", locale: "en", revision: 1 },
          "PUT",
        );
        expect(saved.document.revision).toBe(2);
        const stale = await request(
          `/api/documents/detail?id=${id}`,
          { title: "Stale", content: "Do not replace", locale: "en", revision: 1 },
          "PUT",
        );
        expect(stale.status).toBe(409);
        expect((await stale.json()).code).toBe("conflict");
        expect((await json(`/api/documents/revisions?id=${id}`)).revisions).toHaveLength(2);
        expect((await json(`/api/documents/revisions?id=${id}&revision=${first.revision.id}`)).revision.content).toBe(
          "Original",
        );
        expect((await json(`/api/document-languages?id=${id}`)).documents[0].id).toBe(id);
        const name = "台灣 香港 图.png";
        const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#123456" } })
          .png()
          .toBuffer();
        const uploaded = await fetch(`${base}/api/document-assets?document=${id}&name=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { origin: base, connection: "close" },
          body: png,
        });
        expect(uploaded.status).toBe(201);
        const { asset } = await uploaded.json();
        const content = await request(`/api/document-assets/content?id=${asset.id}`);
        const bytes = Buffer.from(await content.arrayBuffer());
        expect(content.headers.get("content-type")).toBe("image/png");
        expect(content.headers.get("content-length")).toBe(String(bytes.length));
        expect(content.headers.get("cache-control")).toBe("private, no-store");
        expect(content.headers.get("x-content-type-options")).toBe("nosniff");
        expect(content.headers.get("content-security-policy")).toBe("default-src 'none'");
        expect(content.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''" + encodeURIComponent(name));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.digest);
        const badMethod = await request(`/api/documents/detail?id=${id}`, undefined, "DELETE");
        expect(badMethod.status).toBe(405);
        expect(badMethod.headers.get("allow")).toBe("GET, PUT");
        const foreign = await fetch(`${base}/api/documents/detail?id=${id}`, {
          method: "PUT",
          headers: { origin: "https://foreign.test", "content-type": "application/json", connection: "close" },
          body: "{}",
        });
        expect(foreign.status).toBe(403);
        permitted = false;
        expect((await request(`/api/documents/detail?id=${id}`)).status).toBe(404);
        expect((await request(`/api/documents/revisions?id=${id}&revision=${first.revision.id}`)).status).toBe(404);
        expect((await request(`/api/document-assets/content?id=${asset.id}`)).status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await feature.close();
        await mysql?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
