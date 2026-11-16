import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { unzipSync } from "fflate";

const project = "panda-site-test-" + randomUUID().slice(0, 8),
  out = resolve(".artifacts/site-build-compose", project);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(?:PANDA_FORCE_|CODEX_|WEBUI_|PUID$|PGID$|COMPOSE_PROJECT_NAME$)/.test(key),
  ),
);
const token = randomBytes(32).toString("hex");
Object.assign(env, {
  COMPOSE_PROJECT_NAME: project,
  PANDA_FORCE_IMAGE: process.env.PANDA_FORCE_APP_TEST_IMAGE,
  PANDA_FORCE_EXECUTOR_IMAGE: process.env.PANDA_FORCE_EXECUTOR_TEST_IMAGE,
  PANDA_FORCE_DOCUMENT_WORKER_IMAGE: process.env.PANDA_FORCE_WORKER_TEST_IMAGE,
  PANDA_FORCE_PULL_POLICY: "never",
  PANDA_FORCE_EXECUTOR_PULL_POLICY: "never",
  PANDA_FORCE_ENGINE_PULL_POLICY: "never",
  PANDA_FORCE_STATE_VOLUME_NAME: project + "-state",
  PANDA_FORCE_MODEL_VOLUME_NAME: project + "-model",
  PANDA_FORCE_WORKSPACE_VOLUME_NAME: project + "-workspace",
  PANDA_FORCE_PORT: "0",
});
if (![env.PANDA_FORCE_IMAGE, env.PANDA_FORCE_EXECUTOR_IMAGE, env.PANDA_FORCE_DOCUMENT_WORKER_IMAGE].every(Boolean))
  throw Error("Set the three PANDA_FORCE_*_TEST_IMAGE values to verified local images.");
mkdirSync(out, { recursive: true });
const overlay = resolve(out, "compose.private.yml");
writeFileSync(
  overlay,
  JSON.stringify({
    services: {
      "panda-force": {
        environment: {
          PANDA_FORCE_ACCESS_TOKEN: token,
        },
      },
    },
  }),
  { mode: 0o600 },
);
const compose = [
  "docker",
  "compose",
  "--env-file",
  "/dev/null",
  "-p",
  project,
  "-f",
  resolve("docker-compose.yml"),
  "-f",
  resolve("docker-compose.documents.yml"),
  "-f",
  overlay,
];
function command(args) {
  const result = Bun.spawnSync([...compose, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 90000 });
  if (result.exitCode) throw Error(result.stderr.toString().slice(-1000));
  return result.stdout.toString().trim();
}
let cleaned = false;
function cleanup() {
  if (!cleaned) {
    cleaned = true;
    command(["down", "-v", "--remove-orphans"]);
  }
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    cleanup();
    process.exit(1);
  });
try {
  command(["up", "-d", "--no-build", "--wait"]);
  let endpoint = "http://" + command(["port", "panda-force", "8899"]);
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const call = async (path, method = "GET", data) => {
    const response = await fetch(endpoint + path, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await call("/api/site-builds/availability")).state === "ready") {
        ready = true;
        break;
      }
    } catch {
      if (attempt === 49) throw Error("Container application did not become ready");
    }
    await Bun.sleep(400);
  }
  if (!ready) throw Error("Container executor did not become ready");
  const setup = await fetch(endpoint + "/api/auth/setup", {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "compose-owner" }),
  });
  if (!setup.ok) throw Error("Container administrator setup failed");
  const revokedCookie = setup.headers.get("set-cookie")?.split(";")[0];
  if (!revokedCookie) throw Error("Setup did not issue a browser session");
  const logout = await fetch(endpoint + "/api/auth/logout", { method: "POST", headers: { Cookie: revokedCookie } });
  if (!logout.ok) throw Error("Container logout failed");
  const login = await fetch(endpoint + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "compose-owner", password: token }),
  });
  if (!login.ok) throw Error("Container administrator login failed");
  const activeCookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!activeCookie) throw Error("Login did not issue a browser session");
  const catalog = await call("/api/projects"),
    created = await call("/api/projects", "POST", {
      code: "portable-site",
      name: "Portable site",
      revision: catalog.revision,
    });
  const product = created.projects.find((entry) => entry.code === "portable-site");
  const emptyTree = await call("/api/project-document-tree?" + new URLSearchParams({ project: product.id }));
  if (emptyTree.nodes.length || emptyTree.version !== 0) throw Error("A new file project must start empty");
  const createdDocument = await call("/api/project-document-tree/documents", "POST", {
    id: randomUUID(),
    projectId: product.id,
    treeVersion: 0,
    parentId: null,
    title: "Welcome",
    locale: "en",
  });
  const documentId = createdDocument.operation.documentId,
    query = new URLSearchParams({ project: product.id, id: documentId }),
    opened = await call("/api/project-documents/editor?" + query),
    image = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#5155d9" } })
      .png()
      .toBuffer();
  const uploaded = await fetch(
    endpoint +
      "/api/project-documents/assets?" +
      new URLSearchParams({
        project: product.id,
        document: documentId,
        name: "original image.png",
        operationId: randomUUID(),
      }),
    {
      method: "POST",
      headers: { Authorization: headers.Authorization, "Content-Type": "application/octet-stream" },
      body: image,
    },
  );
  if (!uploaded.ok) throw Error("Owned image upload failed");
  const { asset } = await uploaded.json();
  const draft = await call("/api/project-documents/editor?" + query, "PUT", {
    operationId: randomUUID(),
    version: opened.draft.version,
    baseRevisionId: opened.draft.baseRevisionId,
    working: {
      ...opened.working,
      body: {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Portable website" }] },
            {
              type: "paragraph",
              content: [{ type: "text", text: "Built from one saved source.", marks: [{ type: "bold" }] }],
            },
            { type: "image", attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "A local image" } },
          ],
        },
      },
    },
  });
  const checkpoint = await call("/api/project-documents/checkpoints?" + query, "POST", {
      operationId: randomUUID(),
      revisionId: opened.saved.revision.id,
      draftVersion: draft.receipt.version,
    }),
    saved = checkpoint.detail;
  const evidence = {
    applicationRoutes: true,
    isolatedVolumes: true,
    nativeFileDefault: true,
    engines: {},
    publications: {},
  };
  for (const engine of ["hexo", "docusaurus"]) {
    const { space } = await call("/api/project-document-spaces", "POST", {
      operationId: randomUUID(),
      projectId: product.id,
      code: engine,
      name: "Portable handbook",
      engine,
      sourceMode: "managed",
      locale: "en",
      theme: "default",
    });
    await call("/api/project-document-placements?" + new URLSearchParams({ project: product.id }), "POST", {
      operationId: randomUUID(),
      id: randomUUID(),
      documentId,
      spaceId: space.id,
      spaceVersion: space.version,
      path: "welcome.md",
      locale: "en",
      revisionId: saved.revision.id,
      metadata: {},
    });
    const id = randomUUID();
    await call("/api/site-builds", "POST", {
      id,
      projectId: product.id,
      spaceId: space.id,
      engine,
      title: "Portable handbook",
      locale: "en",
      url: "https://docs.example.test",
      basePath: "/handbook/",
    });
    /** @type {{ build: import("../../src/shared/builds/jobs.js").SiteBuild } | undefined} */
    let job;
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      job = await call("/api/site-builds/detail?id=" + id);
      if (["completed", "failed", "cancelled"].includes(job.build.phase)) break;
      await Bun.sleep(1000);
    }
    if (job?.build.phase !== "completed") {
      writeFileSync(resolve(out, engine + "-failed.json"), JSON.stringify(job, null, 2));
      throw Error(engine + " build failed");
    }
    if (job.build.sources[0].revisionId !== saved.revision.id) throw Error("Build source revision mismatch");
    if (
      job.build.sources[0].id !== documentId ||
      job.build.sourceSnapshot?.projectId !== product.id ||
      !/^[a-f0-9]{40}$/.test(job.build.sourceSnapshot?.commit || "")
    )
      throw Error("Frozen file/Git source mismatch");
    const preview = await fetch(endpoint + `/api/site-builds/preview/${id}/index.html`, { headers });
    const previewHtml = await preview.text();
    writeFileSync(resolve(out, engine + "-preview.html"), previewHtml);
    if (!preview.ok || !previewHtml.includes("Content-Security-Policy")) throw Error("Isolated preview missing");
    if (!previewHtml.includes("data:image/png;base64,"))
      throw Error("Named image was not embedded in the site preview");
    const download = await fetch(endpoint + "/api/site-builds/download?id=" + id, { headers });
    if (!download.ok) throw Error("Download failed");
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const original = Object.entries(files).find(([name]) => name.endsWith("/original image.png"));
    if (!files["index.html"] || !original || createHash("sha256").update(original[1]).digest("hex") !== asset.digest)
      throw Error("Output or named asset missing");
    evidence.engines[engine] = {
      id,
      source: job.build.sources,
      files: job.build.fileCount,
      bytes: job.build.outputBytes,
      image: job.build.image,
      originalFilenamePreserved: true,
    };
    const { connection } = await call("/api/publication-connections", "POST", {
      id: randomUUID(),
      projectId: product.id,
      name: engine + " site",
      connector: "local-site",
      root: "local",
      directory: "site-" + engine,
      publicUrl: "https://docs.example.test/handbook/",
    });
    await call("/api/publication-connections/test?id=" + connection.id, "POST", { version: connection.version });
    const { publication } = await call("/api/site-publications", "POST", {
      id: randomUUID(),
      buildId: id,
      projectId: product.id,
      connectionId: connection.id,
      connectionVersion: connection.version,
    });
    if (publication.job.phase !== "prepared") throw Error("A prepared plan must not publish automatically");
    evidence.publications[engine] = {
      id: publication.plan.id,
      fingerprint: publication.plan.fingerprint,
      indexHash: createHash("sha256").update(files["index.html"]).digest("hex"),
      assetPath: original[0],
      assetHash: asset.digest,
    };
    console.log(engine, "application-to-worker build passed", job.build.fileCount, "files");
  }
  command(["up", "-d", "--no-build", "--no-deps", "--force-recreate", "panda-force"]);
  endpoint = "http://" + command(["port", "panda-force", "8899"]);
  let restarted = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await call("/api/site-builds/availability")).state === "ready") {
        restarted = true;
        break;
      }
    } catch {
      /* Container startup may not yet accept connections. */
    }
    await Bun.sleep(250);
  }
  if (!restarted) throw Error("Application did not become ready after restart");
  for (const [cookie, authenticated] of [
    [revokedCookie, false],
    [activeCookie, true],
  ]) {
    const response = await fetch(endpoint + "/api/auth/status", { headers: { Cookie: cookie } });
    const state = await response.json();
    if (!response.ok || state.setupRequired || !state.usernameRequired || state.authenticated !== authenticated)
      throw Error("Administrator or logout state was lost when recreating the application container");
  }
  for (const engine of Object.values(evidence.engines)) {
    const result = await call("/api/site-builds/detail?id=" + engine.id);
    if (result.build.phase !== "completed" || !result.build.artifactAvailable)
      throw Error("Build did not survive restart");
  }
  for (const publication of Object.values(evidence.publications)) {
    const saved = await call("/api/site-publications/detail?id=" + publication.id);
    if (saved.publication.job.phase !== "prepared" || saved.publication.plan.fingerprint !== publication.fingerprint)
      throw Error("Frozen publication plan did not survive container recreation");
    await call("/api/site-publications/publish", "POST", { id: publication.id, fingerprint: publication.fingerprint });
    let published;
    for (let attempt = 0; attempt < 80; attempt++) {
      published = (await call("/api/site-publications/detail?id=" + publication.id)).publication;
      if (published.job.phase === "published") break;
      if (["failed", "needsAttention"].includes(published.job.phase))
        throw Error("Container publication failed: " + published.job.error);
      await Bun.sleep(250);
    }
    if (published?.job.phase !== "published") throw Error("Publication did not finish");
    const hashes = JSON.parse(
      command([
        "exec",
        "-T",
        "panda-force",
        "bun",
        "-e",
        "const fs=require('node:fs'),crypto=require('node:crypto'); const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); console.log(JSON.stringify([hash(process.argv[1]+'/index.html'),hash(process.argv[1]+'/'+process.argv[2])]));",
        published.job.receipt.servedPath,
        publication.assetPath,
      ]),
    );
    if (hashes[0] !== publication.indexHash || hashes[1] !== publication.assetHash)
      throw Error("Published site bytes differ from the frozen build");
    publication.receipt = published.job.receipt;
  }

  const retainedSource = await call("/api/project-documents/source?" + query);
  if (
    JSON.stringify(retainedSource.document) !== JSON.stringify(saved.document) ||
    JSON.stringify(retainedSource.revision) !== JSON.stringify(saved.revision)
  )
    throw Error("Building or publishing changed the canonical original");
  evidence.sameCanonicalRichOriginal = true;
  evidence.restartPreservedBuilds = true;
  evidence.containerRecreated = true;
  evidence.defaultAdministratorPersistence = true;
  evidence.revokedSessionRejectedAfterRecreation = true;
  evidence.frozenPlansSurvivedRecreation = true;
  evidence.bothEnginesPublishedToIsolatedVolume = true;
  writeFileSync(resolve(out, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
} finally {
  cleanup();
}
