import type { ExecutionDriver } from "../driver.js";
import { createHash } from "node:crypto";
import type { BuildExecution } from "../../shared/builds/contracts.js";
import { BUILD_LIMITS, buildArtifact, BuildError } from "../../shared/builds/validation.js";
import type { ExecutorConfig } from "../config.js";
import { DockerApi } from "./api.js";
import { attachWorker } from "./stream.js";
import { resolveWorkerImage } from "./images.js";
import { buildRequirements, resourceBuildRequirements } from "../../shared/builds/capabilities.js";
import { ResourceBuildRequest, type ExecutionInput } from "../../shared/builds/resources.js";
import { encodeResourceBuild } from "../../shared/builds/resource-frame.js";

export class DockerBuildDriver implements ExecutionDriver {
  private api: DockerApi;
  constructor(
    private config: ExecutorConfig,
    private owner: string,
  ) {
    this.api = new DockerApi(config.dockerSocket);
  }
  private name(id: string) {
    return `panda-build-${this.owner}-${id}`;
  }
  async ready() {
    const version = await this.api.json<{ Os: string }>("GET", "/version", { timeout: 3000 });
    if (version.Os !== "linux") throw new BuildError("linuxContainersRequired", 503);
  }
  async cleanup(id: string) {
    const name = this.name(id),
      response = await this.api.call("GET", `/containers/${name}/json`);
    if (response.status === 404) return;
    if (
      response.status !== 200 ||
      JSON.parse(response.data.toString()).Config?.Labels?.["ai.hiforce.panda.executor"] !== this.owner
    )
      throw new BuildError("workerCleanupOwnership", 503);
    const removed = await this.api.call("DELETE", `/containers/${name}?force=true&v=true`);
    if (![204, 404].includes(removed.status)) throw new BuildError("workerCleanupFailed", 503);
  }
  async run(
    id: string,
    input: ExecutionInput,
    signal: AbortSignal,
    update: (change: Partial<BuildExecution>) => void,
    logs: (text: string) => void,
  ) {
    update({ phase: "resolving" });
    const image = await resolveWorkerImage(this.api, this.config.images[input.engine], input.engine, {
      credentials: this.config.registryConfigFile,
      signal,
      requirements:
        input instanceof ResourceBuildRequest
          ? resourceBuildRequirements(input.descriptor.input, input.descriptor.files)
          : buildRequirements(input),
    });
    update({ image });
    const name = this.name(id);
    let deadline: AbortSignal | undefined;
    try {
      await this.api.json("POST", `/containers/create?name=${name}`, {
        signal,
        body: {
          Image: image.id,
          User: "1000:1000",
          WorkingDir: "/work",
          Entrypoint: ["/usr/local/bin/node", "/opt/panda/worker.js"],
          Cmd: [],
          OpenStdin: true,
          StdinOnce: true,
          Env: [
            "HOME=/tmp",
            "NODE_ENV=production",
            "NODE_OPTIONS=--max-old-space-size=1536",
            "DOCUSAURUS_TELEMETRY_DISABLED=true",
          ],
          Labels: { "ai.hiforce.panda.executor": this.owner, "ai.hiforce.panda.build": id },
          HostConfig: {
            NetworkMode: "none",
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            Memory: 2147483648,
            MemorySwap: 2147483648,
            NanoCpus: 2000000000,
            PidsLimit: 128,
            Init: true,
            Tmpfs: {
              "/tmp": "rw,nosuid,nodev,size=268435456,mode=1777",
              "/work": "rw,nosuid,nodev,size=805306368,uid=1000,gid=1000,mode=0700",
            },
            LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
            Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }],
          },
        },
      });
      await this.api.json("POST", `/containers/${name}/start`, { signal });
      update({ phase: "running" });
      deadline = AbortSignal.timeout(this.config.timeoutMs);
      const bounded = AbortSignal.any([signal, deadline]);
      const output = await attachWorker(
        this.config.dockerSocket,
        name,
        input instanceof ResourceBuildRequest
          ? Buffer.from(encodeResourceBuild(input))
          : Buffer.from(JSON.stringify(input) + "\n"),
        bounded,
        logs,
      );
      const stopped = await this.api.json<{ StatusCode: number }>(
        "POST",
        `/containers/${name}/wait?condition=not-running`,
        { signal: bounded },
      );
      if (stopped.StatusCode !== 0) throw new BuildError("engineBuildFailed", 422);
      const artifact = buildArtifact(JSON.parse(output.toString("utf8")));
      for (const file of artifact.files)
        if (createHash("sha256").update(Buffer.from(file.data, "base64")).digest("hex") !== file.sha256)
          throw new BuildError("artifactDigestMismatch", 502);
      if (artifact.bytes > BUILD_LIMITS.outputBytes) throw new BuildError("artifactTooLarge", 413);
      return artifact;
    } catch (error) {
      if (signal.aborted) throw new BuildError("cancelled", 409);
      if (deadline?.aborted) throw new BuildError("buildTimeout", 504);
      throw error;
    } finally {
      await this.cleanup(id);
    }
  }
}
