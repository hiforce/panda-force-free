import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BuildInput, BuildExecution, BuildArtifact } from "../shared/builds/contracts.js";
import { buildId, buildArtifact, BuildError } from "../shared/builds/validation.js";
import { utf8Prefix } from "../shared/utf8.js";
import { ResourceBuildRequest } from "../shared/builds/resources.js";
import { encodeResourceBuild, decodeResourceBuild } from "../shared/builds/resource-frame.js";
import { readResourceFile } from "./resource-file.js";

const logLimit = 128 * 1024;
export interface ExecutionStorageLimits {
  maxBytes: number;
  maxJobs: number;
  retentionMs: number;
}
const defaults: ExecutionStorageLimits = { maxBytes: 512 * 1024 * 1024, maxJobs: 200, retentionMs: 7 * 86400000 };

/** One executor process owns this directory; callers use stable IDs across network retries. */
export class ExecutionStore {
  readonly owner: string;
  constructor(
    private root: string,
    private limits: ExecutionStorageLimits = defaults,
  ) {
    if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit <= 0))
      throw new BuildError("invalidExecutorLimits", 500);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const ownerFile = join(root, "owner");
    if (!existsSync(ownerFile)) writeFileSync(ownerFile, randomUUID().slice(0, 8), { flag: "wx", mode: 0o600 });
    this.owner = readFileSync(ownerFile, "utf8").trim();
    if (!/^[a-f0-9]{8}$/.test(this.owner)) throw new BuildError("invalidExecutorIdentity", 500);
    mkdirSync(join(root, "jobs"), { recursive: true, mode: 0o700 });
  }
  private file(id: string, name: string) {
    return join(this.root, "jobs", buildId(id), name);
  }
  private write(id: string, name: string, value: unknown) {
    const path = this.file(id, name),
      temp = `${path}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  ids() {
    return readdirSync(join(this.root, "jobs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
      .map((entry) => entry.name)
      .filter((id) => existsSync(this.file(id, "state.json")));
  }
  private reserve(bytes: number) {
    // Reserve the full bounded log for every retained job before accepting more data.
    const occupied = this.ids().reduce((total, id) => {
      let size = logLimit;
      for (const name of ["state.json", "input.json", "input.build", "result.json"])
        if (existsSync(this.file(id, name))) size += statSync(this.file(id, name)).size;
      return total + size;
    }, 0);
    if (occupied + bytes > this.limits.maxBytes) throw new BuildError("executorStorageFull", 507);
  }
  create(id: string, input: BuildInput) {
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if (existsSync(this.file(id, "state.json"))) {
      const existing = this.get(id);
      if (existing.inputHash !== inputHash) throw new BuildError("idempotencyConflict", 409);
      return existing;
    }
    this.prune();
    if (this.ids().length >= this.limits.maxJobs) throw new BuildError("executorStorageFull", 507);
    this.reserve(Buffer.byteLength(JSON.stringify(input)) + logLimit + 4096);
    mkdirSync(join(this.root, "jobs", id), { recursive: true, mode: 0o700 });
    const record: BuildExecution = {
      id,
      engine: input.engine,
      inputHash,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      this.write(id, "input.json", input);
      this.write(id, "state.json", record);
    } catch (error) {
      rmSync(join(this.root, "jobs", id), { recursive: true, force: true });
      throw error;
    }
    return record;
  }
  createResource(id: string, input: ResourceBuildRequest) {
    if (!(input instanceof ResourceBuildRequest)) throw new BuildError("invalidResourceBuild");
    if (existsSync(this.file(id, "state.json"))) {
      const existing = this.get(id);
      if (existing.inputHash !== input.digest) throw new BuildError("idempotencyConflict", 409);
      return existing;
    }
    const bytes = encodeResourceBuild(input);
    this.prune();
    if (this.ids().length >= this.limits.maxJobs) throw new BuildError("executorStorageFull", 507);
    this.reserve(bytes.length + logLimit + 4096);
    const directory = join(this.root, "jobs", buildId(id));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const record: BuildExecution = {
      id,
      engine: input.engine,
      inputHash: input.digest,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      writeFileSync(this.file(id, "input.build"), bytes, { flag: "wx", mode: 0o600 });
      this.write(id, "state.json", record);
      // A successful native admission owns both file bodies and directory entries durably.
      for (const path of [
        this.file(id, "input.build"),
        this.file(id, "state.json"),
        directory,
        join(this.root, "jobs"),
        join(this.root, "owner"),
        this.root,
      ]) {
        const handle = openSync(path, "r");
        try {
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return record;
  }
  get(id: string): BuildExecution {
    const path = this.file(id, "state.json");
    if (!existsSync(path)) throw new BuildError("buildNotFound", 404);
    return JSON.parse(readFileSync(path, "utf8"));
  }
  update(id: string, changes: Partial<BuildExecution>) {
    const state = { ...this.get(id), ...changes, id, updatedAt: Date.now() };
    this.write(id, "state.json", state);
    if (["completed", "failed"].includes(state.phase)) {
      rmSync(this.file(id, "input.json"), { force: true });
      rmSync(this.file(id, "input.build"), { force: true });
      if (state.phase === "failed") rmSync(this.file(id, "result.json"), { force: true });
    }
    return state;
  }
  input(id: string): BuildInput {
    return JSON.parse(readFileSync(this.file(id, "input.json"), "utf8"));
  }
  async request(id: string) {
    const path = this.file(id, "input.build");
    if (!existsSync(path)) return this.input(id);
    const input = await decodeResourceBuild(readResourceFile(path));
    if (input.digest !== this.get(id).inputHash) throw new BuildError("inputDigestMismatch");
    return input;
  }
  complete(id: string, artifact: BuildArtifact) {
    this.reserve(Buffer.byteLength(JSON.stringify(artifact)));
    this.write(id, "result.json", artifact);
    this.update(id, { phase: "completed" });
  }
  result(id: string) {
    if (this.get(id).phase !== "completed") throw new BuildError("buildNotCompleted", 409);
    const artifact = buildArtifact(JSON.parse(readFileSync(this.file(id, "result.json"), "utf8")));
    for (const file of artifact.files)
      if (createHash("sha256").update(Buffer.from(file.data, "base64")).digest("hex") !== file.sha256)
        throw new BuildError("artifactDigestMismatch", 500);
    return artifact;
  }
  logs(id: string, value: string) {
    writeFileSync(this.file(id, "output.log"), utf8Prefix(value, logLimit), { mode: 0o600 });
  }
  readLogs(id: string) {
    this.get(id);
    const path = this.file(id, "output.log");
    return existsSync(path) ? utf8Prefix(readFileSync(path), logLimit) : "";
  }
  prune(now = Date.now()) {
    // An interrupted native admission has no receipt and cannot own an unbounded orphan payload.
    for (const entry of readdirSync(join(this.root, "jobs"), { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(entry.name) &&
        !existsSync(this.file(entry.name, "state.json")) &&
        existsSync(this.file(entry.name, "input.build"))
      )
        rmSync(join(this.root, "jobs", entry.name), { recursive: true, force: true });
    }
    for (const id of this.ids()) {
      const state = this.get(id);
      if (["completed", "failed"].includes(state.phase)) {
        rmSync(this.file(id, "input.json"), { force: true });
        rmSync(this.file(id, "input.build"), { force: true });
        if (state.phase === "failed") rmSync(this.file(id, "result.json"), { force: true });
        if (now - state.updatedAt > this.limits.retentionMs)
          rmSync(join(this.root, "jobs", id), { recursive: true, force: true });
      }
    }
  }
}
