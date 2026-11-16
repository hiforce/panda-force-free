import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppFixture } from "./app-fixture.mjs";

/** Real application routes use a deterministic executor peer; no external registry or publisher is contacted. */
export async function createSiteBuildFixture({ workspaceDirectory = null } = {}) {
  const token = randomBytes(32).toString("hex"),
    jobs = new Map(),
    inputs = new Map();
  const starts = [];
  let finish = true,
    fail = false,
    lose = false;
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ ok: true });
      if (path === "/v1/capabilities")
        return Response.json({
          protocol: 1,
          features: ["site-themes/v1", "trusted-themes/v1", "site-projects/v1"],
          engines: { hexo: "8.1.1", docusaurus: "3.10.2" },
        });
      const match = /^\/v1\/builds\/([^/]+)(?:\/(logs|result))?$/.exec(path);
      if (!match) return new Response(null, { status: 404 });
      const [, id, action] = match;
      if (req.method === "PUT") {
        const input = await req.json();
        starts.push(id);
        if (!jobs.has(id)) {
          inputs.set(id, input);
          jobs.set(id, {
            id,
            inputHash: hash(JSON.stringify(input)),
            engine: input.engine,
            phase: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        if (lose) {
          lose = false;
          return new Response(null, { status: 503 });
        }
      }
      const job = jobs.get(id);
      if (!job) return new Response(null, { status: 404 });
      if (req.method === "DELETE") {
        job.phase = "failed";
        job.error = "cancelled";
      }
      if (finish && job.phase === "running") {
        job.phase = fail ? "failed" : "completed";
        if (fail) job.error = "engineBuildFailed";
      }
      if (action === "logs")
        return Response.json({ logs: fail ? "Fixture build failed\n" : "Fixture build completed\n" });
      if (action === "result") {
        const input = inputs.get(id);
        const data = (path, value) => ({ path, data: Buffer.from(value).toString("base64"), sha256: hash(value) });
        const files = [
          data(
            "index.html",
            `<html><head><link rel="stylesheet" href="${input.site.basePath}style.css"></head><body><h1>Fixture website</h1><a href="${input.site.basePath}about/">About fixture</a><img src="${input.site.basePath}picture.svg"><script>parent.__unsafeBuild = true;</script><img src="https://untrusted.example/pixel"></body></html>`,
          ),
          data("about/index.html", "<html><body><h1>About fixture</h1></body></html>"),
          data("style.css", "h1{color:rgb(42, 63, 84)}"),
          data(
            "picture.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="blue"/></svg>',
          ),
          ...input.assets.map((asset) => ({ ...asset, path: "assets/" + asset.path })),
        ];
        return Response.json({
          protocol: 1,
          files,
          bytes: files.reduce((sum, file) => sum + Buffer.from(file.data, "base64").length, 0),
        });
      }
      return Response.json(job);
    },
  });
  let app;
  try {
    app = await createAppFixture({
      workspaceDirectory,
      extraEnvironment({ dir }) {
        const file = join(dir, "build-token");
        writeFileSync(file, token, { mode: 0o600 });
        return {
          PANDA_FORCE_BUILD_EXECUTOR_URL: `http://127.0.0.1:${server.port}`,
          PANDA_FORCE_BUILD_EXECUTOR_TOKEN_FILE: file,
        };
      },
    });
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  return {
    app,
    jobs,
    inputs,
    starts,
    hold: () => {
      finish = false;
    },
    finish: () => {
      finish = true;
    },
    fail: () => {
      fail = true;
      finish = true;
    },
    loseAck: () => {
      lose = true;
    },
    async dispose() {
      await app.dispose();
      await server.stop(true);
    },
  };
}
