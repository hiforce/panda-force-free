import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionService } from "../../src/executor/service.js";
import { ExecutionStore } from "../../src/executor/store.js";
import { executionHandler } from "../../src/executor/http.js";
import { BuildError } from "../../src/shared/builds/errors.js";
import type { BuildInput } from "../../src/shared/builds/contracts.js";
import { sampleArtifact } from "./site-sample-fixture.js";
import { ResourceBuildRequest } from "../../src/shared/builds/resources.js";

/** Exercises the real executor transport with deterministic, manually released disposable work. */
export async function createSampleExecutorHttp(options: { native?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "panda-sample-http-")),
    token = "b".repeat(64);
  const inputs = new Map<string, BuildInput>(),
    gates = new Map<string, () => void>(),
    resources = new Map<string, { digest: string; paths: string[]; logo: Uint8Array | null }>();
  const faults = { statusUnavailable: false, loseStartAcknowledgement: false, disabledFeatures: new Set<string>() };
  const failed = new Set<string>();
  let active = 0;
  const service = new ExecutionService(
    new ExecutionStore(root),
    {
      async run(id, input, signal, update, logs) {
        if (input instanceof ResourceBuildRequest && !options.native)
          throw new BuildError("resourceBuildFixtureUnsupported");
        active++;
        inputs.set(id, structuredClone(input instanceof ResourceBuildRequest ? input.descriptor.input : input));
        if (input instanceof ResourceBuildRequest)
          resources.set(id, {
            digest: input.digest,
            paths: input.tree.files.map((file) => file.path),
            logo: input.tree.has("source/logo.bin") ? input.tree.read("source/logo.bin") : null,
          });
        update({
          phase: "running",
          image: { reference: "registry.example.test/worker:fixture", id: "sha256:" + "a".repeat(64), digest: null },
        });
        logs("A fixed website sample is building.");
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              gates.delete(id);
              reject(new BuildError("cancelled", 409));
            };
            if (signal.aborted) return abort();
            signal.addEventListener("abort", abort, { once: true });
            gates.set(id, () => {
              signal.removeEventListener("abort", abort);
              gates.delete(id);
              resolve();
            });
          });
          if (failed.has(id)) throw new BuildError("engineBuildFailed", 422);
          logs("A fixed website sample completed.");
          return sampleArtifact();
        } finally {
          active--;
        }
      },
      async cleanup() {},
    },
    () => {},
  );
  const handler = executionHandler(service, token),
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (faults.statusUnavailable && request.method === "GET" && /^\/v1\/builds\/[^/]+$/.test(path))
          return Response.json({ error: "executorUnavailable" }, { status: 503 });
        const response = await handler(request);
        if (path === "/v1/capabilities" && response.ok && faults.disabledFeatures.size) {
          const value = (await response.json()) as { features: string[] };
          value.features = value.features.filter((feature) => !faults.disabledFeatures.has(feature));
          return Response.json(value);
        }
        if (
          faults.loseStartAcknowledgement &&
          request.method === "PUT" &&
          path.startsWith("/v2/builds/") &&
          response.status === 202
        ) {
          faults.loseStartAcknowledgement = false;
          await response.arrayBuffer();
          return Response.json({ error: "executorUnavailable" }, { status: 503 });
        }
        return response;
      },
    });
  return {
    url: server.url.origin,
    token,
    inputs,
    gates,
    resources,
    faults,
    release(id: string, fail = false) {
      if (fail) failed.add(id);
      const release = gates.get(id);
      if (!release) throw Error("Sample is not running");
      release();
    },
    async stop() {
      service.close();
      server.stop(true);
      const deadline = Date.now() + 5000;
      while (active && Date.now() < deadline) await Bun.sleep(10);
      if (active) throw Error("Sample driver did not stop");
      await rm(root, { recursive: true, force: true });
    },
  };
}
