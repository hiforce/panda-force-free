import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.cwd(),
  project = "panda-doc-test-" + randomUUID().slice(0, 8),
  out = resolve(".artifacts/document-executor-e2e", project);
const images = {
  app: process.env.PANDA_FORCE_APP_TEST_IMAGE,
  executor: process.env.PANDA_FORCE_EXECUTOR_TEST_IMAGE,
  worker: process.env.PANDA_FORCE_WORKER_TEST_IMAGE,
};
if (Object.values(images).some((value) => !value))
  throw Error(
    "Set PANDA_FORCE_APP_TEST_IMAGE, PANDA_FORCE_EXECUTOR_TEST_IMAGE and PANDA_FORCE_WORKER_TEST_IMAGE to verified local images.",
  );
const mirror = Object.fromEntries(
  Object.keys(images).map((name) => [name, `registry.example.invalid/${project}/${name}:fixture`]),
);
mkdirSync(out, { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^PANDA_FORCE_|^CODEX_|^WEBUI_|^PUID$|^PGID$|^COMPOSE_PROJECT_NAME$/.test(k),
  ),
);
Object.assign(env, {
  PANDA_FORCE_IMAGE: mirror.app,
  PANDA_FORCE_PULL_POLICY: "never",
  PANDA_FORCE_EXECUTOR_IMAGE: mirror.executor,
  PANDA_FORCE_EXECUTOR_PULL_POLICY: "never",
  PANDA_FORCE_HEXO_IMAGE: mirror.worker,
  PANDA_FORCE_DOCUSAURUS_IMAGE: mirror.worker,
  PANDA_FORCE_ENGINE_PULL_POLICY: "never",
});
const overlay = resolve(out, "compose.yml");
writeFileSync(overlay, 'services:\n  panda-executor:\n    ports:\n      - "127.0.0.1::8900"\n');
const args = [
  "docker",
  "compose",
  "-p",
  project,
  "-f",
  resolve("docker-compose.yml"),
  "-f",
  resolve("docker-compose.documents.yml"),
  "-f",
  overlay,
];
function command(parts) {
  const result = Bun.spawnSync(parts, { env, cwd: root, stdout: "pipe", stderr: "pipe", timeout: 90000 });
  if (result.exitCode) throw Error(result.stderr.toString().slice(-1500));
  return result.stdout.toString().trim();
}
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  command([...args, "down", "-v", "--remove-orphans"]);
  for (const image of Object.values(mirror)) command(["docker", "image", "rm", image]);
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    cleanup();
    process.exit(1);
  });
try {
  for (const [kind, image] of Object.entries(images)) command(["docker", "tag", image, mirror[kind]]);
  command([...args, "up", "-d", "--no-build", "--wait", "panda-executor"]);
  const endpoint = "http://" + command([...args, "port", "panda-executor", "8900"]);
  const token = command([...args, "exec", "-T", "panda-executor", "cat", "/run/panda-executor/token"]);
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  console.log("executor ready", project);
  const shared = command([
    ...args,
    "run",
    "--rm",
    "--no-deps",
    "panda-force",
    "bun",
    "-e",
    `const token=(await Bun.file('/run/panda-executor/token').text()).trim();const r=await fetch('http://panda-executor:8900/v1/capabilities',{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('Executor unavailable');console.log(JSON.stringify(await r.json()));`,
  ]);
  const cap = JSON.parse(shared);
  if (!cap.engines.hexo) throw Error("Application cannot connect");
  const evidence = { applicationConnected: true, imageOverridesVerified: true, pullPolicy: "never", engines: {} };
  const asset = Buffer.alloc(8 * 1024 * 1024, 7);
  for (const engine of ["hexo", "docusaurus"]) {
    const id = randomUUID(),
      input = {
        protocol: 1,
        engine,
        preset: engine === "hexo" ? "reader" : "handbook",
        site: {
          title: "Portable document space",
          url: "https://docs.example.test",
          basePath: "/",
          locale: engine === "hexo" ? "en" : "zh-CN",
        },
        documents: [
          {
            id: "fixture-a",
            path: "intro.md",
            title: "Welcome",
            content:
              '# Hello from a portable build\n\nNo Kubernetes or private project content.\n\n```js\nconsole.log("ready");\n```',
          },
        ],
        assets: [
          {
            path: "large-fixture.bin",
            data: asset.toString("base64"),
            sha256: createHash("sha256").update(asset).digest("hex"),
          },
        ],
      };
    const start = await fetch(endpoint + "/v1/builds/" + id, { method: "PUT", headers, body: JSON.stringify(input) });
    if (start.status !== 202) throw Error(await start.text());
    const deadline = Date.now() + 300000;
    let verified = false,
      status;
    while (Date.now() < deadline) {
      status = await (await fetch(endpoint + "/v1/builds/" + id, { headers })).json();
      if (status.phase === "running" && !verified) {
        const names = command(["docker", "ps", "-q", "--filter", "label=ai.hiforce.panda.build=" + id]);
        if (names) {
          const inspect = JSON.parse(command(["docker", "inspect", names]))[0];
          if (
            inspect.HostConfig.NetworkMode !== "none" ||
            !inspect.HostConfig.ReadonlyRootfs ||
            inspect.Mounts.some((m) => m.Type === "bind") ||
            inspect.Config.User !== "1000:1000" ||
            inspect.Config.Env.some((s) => /token|password|credential/i.test(s))
          )
            throw Error("Unsafe worker configuration");
          verified = true;
        }
      }
      if (["completed", "failed"].includes(status.phase)) break;
      await Bun.sleep(1000);
    }
    if (status.phase !== "completed") {
      const log = await (await fetch(endpoint + "/v1/builds/" + id + "/logs", { headers })).json();
      writeFileSync(resolve(out, engine + "-failed.json"), JSON.stringify({ status, log }, null, 2));
      throw Error(engine + ": " + JSON.stringify(status));
    }
    if (status.image.reference !== mirror.worker) throw Error("Configured mirror override was not used");
    const result = await (await fetch(endpoint + "/v1/builds/" + id + "/result", { headers })).json();
    for (const f of result.files)
      if (createHash("sha256").update(Buffer.from(f.data, "base64")).digest("hex") !== f.sha256)
        throw Error("Invalid artifact");
    if (!result.files.some((f) => f.path === "index.html") || !verified)
      throw Error("Missing output or isolation evidence");
    if (
      !result.files.some(
        (file) => file.path === "assets/large-fixture.bin" && Buffer.from(file.data, "base64").length === asset.length,
      )
    )
      throw Error("Large asset was not preserved");
    const orphan = command(["docker", "ps", "-aq", "--filter", "label=ai.hiforce.panda.build=" + id]);
    if (orphan) throw Error("Worker was not removed");
    evidence.engines[engine] = {
      passed: true,
      files: result.files.length,
      bytes: result.bytes,
      image: status.image,
      isolationVerified: verified,
      largeAssetPreserved: true,
      locale: input.site.locale,
    };
    console.log(engine, "passed", result.files.length, "files");
  }
  writeFileSync(resolve(out, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
} finally {
  cleanup();
}
