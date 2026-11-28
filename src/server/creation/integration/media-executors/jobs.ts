import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { CreationMediaBinding } from "../../../../shared/creation/media-executors.js";
import { stableJson } from "../../../../shared/stable-json.js";
import { FilePackageContent } from "../../../packages/content-store.js";
import { creationDigest, creationId, creationRecord, creationText, creationUuid } from "../../validation.js";
import {
  MediaExecutorError,
  type CreationMediaExecutorPort,
  type MediaResult,
} from "../../media-executors/contracts.js";
import { mediaBinding } from "../../media-executors/selection.js";

type Binding = Extract<CreationMediaBinding, { source: "executor" }>;
type Stage = "queued" | "dispatch" | "pending" | "result" | "failed" | "cancelled" | "stoppedLocally";
interface Identity {
  slot: string;
  signature: string;
}
interface Reference extends Identity {
  scopeDigest: string;
}
interface Entry extends Identity {
  stage: Stage;
  scopeDigest?: string;
  taskId?: string;
  bytesDigest?: string;
  invocationId?: string;
}
export interface MediaJobScope {
  owner: string;
  creationId: string;
  projectId: string;
  inputDigest: string;
  binding: Binding;
}
type Pending = Identity & { scope: MediaJobScope; taskId: string };
type Ready = Extract<MediaResult, { state: "succeeded" }>;
export type MediaRecoveryAction = boolean | "cancel";
type Recovery = (scope: MediaJobScope) => MediaRecoveryAction | Promise<MediaRecoveryAction>;

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const scopeDigest = (scope: MediaJobScope) => digest(stableJson(scope));
const referenceId = (reference: Reference) => digest(stableJson(reference));

function reference(value: unknown): Reference {
  const row = creationRecord(value, ["slot", "signature", "scopeDigest"]);
  return {
    slot: creationDigest(row.slot),
    signature: creationDigest(row.signature),
    scopeDigest: creationDigest(row.scopeDigest),
  };
}

function entry(value: unknown): Entry {
  const row = creationRecord(value, [
    "slot",
    "signature",
    "stage",
    "scopeDigest",
    "taskId",
    "bytesDigest",
    "invocationId",
  ]);
  if (
    row.stage !== "queued" &&
    row.stage !== "dispatch" &&
    row.stage !== "pending" &&
    row.stage !== "result" &&
    row.stage !== "failed" &&
    row.stage !== "cancelled" &&
    row.stage !== "stoppedLocally"
  )
    throw new MediaExecutorError("invalidResult");
  const taskId = row.taskId === undefined ? undefined : creationText(row.taskId, 160),
    bytesDigest = row.bytesDigest === undefined ? undefined : creationDigest(row.bytesDigest),
    invocationId = row.invocationId === undefined ? undefined : creationText(row.invocationId, 160);
  if ((row.stage === "pending") !== !!taskId || (row.stage === "result") !== !!bytesDigest)
    throw new MediaExecutorError("invalidResult");
  return {
    slot: creationDigest(row.slot),
    signature: creationDigest(row.signature),
    stage: row.stage,
    ...(row.scopeDigest !== undefined ? { scopeDigest: creationDigest(row.scopeDigest) } : {}),
    ...(taskId ? { taskId } : {}),
    ...(bytesDigest ? { bytesDigest } : {}),
    ...(invocationId ? { invocationId } : {}),
  };
}

function pendingEntry(value: unknown): Pending {
  const row = creationRecord(value, ["slot", "signature", "scope", "taskId"]);
  const scope = creationRecord(row.scope, ["owner", "creationId", "projectId", "inputDigest", "binding"]);
  const binding = mediaBinding(scope.binding);
  if (binding.source !== "executor") throw new MediaExecutorError("invalidResult");
  return {
    slot: creationDigest(row.slot),
    signature: creationDigest(row.signature),
    taskId: creationText(row.taskId, 160),
    scope: {
      owner: creationText(scope.owner, 200),
      creationId: creationUuid(scope.creationId),
      projectId: creationId(scope.projectId),
      inputDigest: creationDigest(scope.inputDigest),
      binding,
    },
  };
}

function absence(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

/** Only the process holding a durable dispatch claim may submit a paid operation. Recovery only polls known IDs. */
export class CreationMediaJobs {
  private readonly jobs: FilePackageContent<Entry>;
  private readonly references: FilePackageContent<Reference>;
  private readonly pending: FilePackageContent<Pending>;
  private readonly originals: FilePackageContent<Uint8Array>;
  private readonly pendingRoot: string;
  private readonly polling = new Map<string, Promise<void>>();
  private readonly submitting = new Set<string>();
  private readonly saving = new Set<string>();
  private recovery?: { controller: AbortController; work: Promise<void> };

  constructor(
    root: string,
    private readonly executors: Pick<CreationMediaExecutorPort, "assertBound" | "submit" | "poll" | "cancel">,
    private readonly pollDelayMs = 1500,
  ) {
    this.jobs = new FilePackageContent(join(root, "jobs"), {
      maxBytes: 4096,
      encode: async (item) => Buffer.from(stableJson(entry(item))),
      decode: async (bytes) => entry(JSON.parse(Buffer.from(bytes).toString("utf8"))),
      digest: ({ slot, stage }) => digest(stableJson({ slot, stage })),
    });
    this.references = new FilePackageContent(join(root, "references"), {
      maxBytes: 1024,
      encode: async (item) => Buffer.from(stableJson(reference(item))),
      decode: async (bytes) => reference(JSON.parse(Buffer.from(bytes).toString("utf8"))),
      digest: referenceId,
    });
    this.pendingRoot = join(root, "pending");
    this.pending = new FilePackageContent(this.pendingRoot, {
      maxBytes: 4096,
      encode: async (item) => Buffer.from(stableJson(pendingEntry(item))),
      decode: async (bytes) => pendingEntry(JSON.parse(Buffer.from(bytes).toString("utf8"))),
      digest: ({ slot }) => slot,
    });
    this.originals = new FilePackageContent<Uint8Array>(join(root, "results"), {
      maxBytes: 32 * 1024 * 1024,
      extension: ".source",
      encode: async (bytes) => bytes,
      decode: async (bytes) => bytes,
      digest,
    });
  }

  private identity({ owner, binding }: MediaJobScope, callId: string, prompt: string): Identity {
    // Preserve the existing request identity so an earlier receipt cannot be billed again after upgrade.
    return {
      slot: digest(stableJson({ owner, callId })),
      signature: digest(stableJson({ binding, prompt })),
    };
  }

  private reference(scope: MediaJobScope, callId: string, prompt: string): Reference {
    return { ...this.identity(scope, callId, prompt), scopeDigest: scopeDigest(scope) };
  }

  async existingId(scope: MediaJobScope, callId: string, prompt: string) {
    const id = referenceId(this.reference(scope, callId, prompt));
    return (await this.references.read(id).catch(absence)) ? id : undefined;
  }

  private async receipt(identity: Identity, stage: Stage) {
    const item = await this.jobs.read(digest(stableJson({ slot: identity.slot, stage }))).catch(absence);
    if (item && item.signature !== identity.signature) throw new MediaExecutorError("conflict");
    return item;
  }

  private async acknowledged(identity: Identity, scope: MediaJobScope) {
    const saved = await this.pending.read(identity.slot).catch(absence);
    if (saved) {
      if (saved.signature !== identity.signature || stableJson(saved.scope) !== stableJson(scope))
        throw new MediaExecutorError("conflict");
      return saved;
    }
    const legacy = await this.receipt(identity, "pending");
    if (legacy?.taskId) return this.acknowledge(identity, scope, legacy.taskId);
  }

  private async acknowledge(identity: Identity, scope: MediaJobScope, taskId: string) {
    const job = pendingEntry({ slot: identity.slot, signature: identity.signature, scope, taskId });
    if (!(await this.pending.insert(job)) && stableJson(await this.pending.read(identity.slot)) !== stableJson(job))
      throw new MediaExecutorError("conflict");
    return job;
  }

  private async forget(identity: Identity) {
    await unlink(join(this.pendingRoot, identity.slot + ".json")).catch(absence);
  }

  private record(identity: Identity, fields: Omit<Entry, keyof Identity>) {
    return this.jobs.insert({ slot: identity.slot, signature: identity.signature, ...fields });
  }

  private async store(identity: Identity, result: Ready) {
    this.saving.add(identity.slot);
    try {
      await this.originals.put(result.bytes);
      await this.record(identity, {
        stage: "result",
        bytesDigest: digest(result.bytes),
        invocationId: result.invocationId,
      });
    } finally {
      this.saving.delete(identity.slot);
    }
  }

  private async result(identity: Identity) {
    const item = await this.receipt(identity, "result");
    if (!item?.bytesDigest) return undefined;
    const bytes = Buffer.from(await this.originals.read(item.bytesDigest));
    if (digest(bytes) !== item.bytesDigest) throw new MediaExecutorError("invalidResult");
    return { bytes, invocationId: item.invocationId };
  }

  /** The lookup uses the frozen creation scope and never contacts the worker or provider. */
  async status(scope: MediaJobScope, jobId: string) {
    const identity = await this.references.read(creationDigest(jobId)).catch(absence);
    if (!identity || identity.scopeDigest !== scopeDigest(scope)) throw new MediaExecutorError("notFound");
    if (await this.receipt(identity, "result")) return "ready" as const;
    if (await this.receipt(identity, "failed")) return "failed" as const;
    const stopped = await this.stopped(identity);
    if (stopped) return stopped;
    if (this.saving.has(identity.slot)) return "saving" as const;
    if (this.submitting.has(identity.slot)) return "generating" as const;
    if (await this.acknowledged(identity, scope)) return "generating" as const;
    if (await this.receipt(identity, "dispatch")) return "awaitingConfirmation" as const;
    if (await this.receipt(identity, "queued")) return "queued" as const;
    throw new MediaExecutorError("notFound");
  }

  private async stopped(identity: Identity) {
    if (await this.receipt(identity, "cancelled")) return "cancelled" as const;
    if (await this.receipt(identity, "stoppedLocally")) return "stoppedLocally" as const;
  }

  private async assertRunning(identity: Identity) {
    const stopped = await this.stopped(identity);
    if (stopped) throw new MediaExecutorError(stopped);
    if (await this.receipt(identity, "failed")) throw new MediaExecutorError("failed");
  }

  private advance(job: Pending, signal: AbortSignal, authorize: () => void | boolean | Promise<void | boolean>) {
    const active = this.polling.get(job.slot);
    if (active) return active;
    const work = this.poll(job, signal, authorize).finally(() => this.polling.delete(job.slot));
    this.polling.set(job.slot, work);
    return work;
  }

  private async poll(job: Pending, signal: AbortSignal, authorize: () => void | boolean | Promise<void | boolean>) {
    if (!(await this.receipt(job, "result")) && !(await this.receipt(job, "failed")) && !(await this.stopped(job))) {
      if ((await authorize()) === false) return;
      signal.throwIfAborted();
      const reply = await this.executors.poll(job.scope.owner, job.scope.binding, job.taskId, signal).catch((error) => {
        if (error instanceof MediaExecutorError && error.code === "stoppedLocally") return;
        throw error;
      });
      if (!reply) {
        // Retain the provider receipt before removing this job from the polling queue.
        await this.record(job, { stage: "pending", taskId: job.taskId });
        await this.record(job, { stage: "stoppedLocally" });
        await this.forget(job);
        return;
      }
      if (reply.state === "pending") {
        if (reply.taskId !== job.taskId) throw new MediaExecutorError("invalidResult");
        return;
      }
      if (reply.state === "succeeded") await this.store(job, reply);
      else await this.record(job, { stage: "failed" });
    }
    await this.forget(job);
  }

  private async stop(job: Pending, signal: AbortSignal, diagnostic: (error: unknown) => void) {
    if (!(await this.receipt(job, "result")) && !(await this.receipt(job, "failed")) && !(await this.stopped(job))) {
      let state: "cancelled" | "stoppedLocally" = "stoppedLocally";
      try {
        const reply = await this.executors.cancel(
          job.scope.owner,
          job.scope.binding,
          job.taskId,
          AbortSignal.any([signal, AbortSignal.timeout(50000)]),
        );
        if (reply.state === "cancelled") state = "cancelled";
      } catch (error) {
        signal.throwIfAborted();
        diagnostic(error);
      }
      await this.record(job, { stage: state });
    }
    await this.forget(job);
  }

  start(authorize: Recovery, diagnostic: (error: unknown) => void) {
    if (this.recovery) return;
    const controller = new AbortController();
    const work = this.recover(authorize, diagnostic, controller.signal);
    this.recovery = { controller, work };
  }

  async close() {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.controller.abort(new MediaExecutorError("unavailable"));
    await recovery.work;
    if (this.recovery === recovery) this.recovery = undefined;
  }

  private async recover(authorize: Recovery, diagnostic: (error: unknown) => void, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const files = (await readdir(this.pendingRoot, { withFileTypes: true }).catch(absence)) ?? [];
        for (const file of files) {
          if (signal.aborted) return;
          if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
          try {
            const job = await this.pending.read(file.name.slice(0, -5)).catch(absence);
            if (!job || this.polling.has(job.slot)) continue;
            const action = await authorize(job.scope);
            if (action === "cancel") {
              await this.stop(job, signal, diagnostic);
            } else if (action) {
              await this.advance(
                job,
                AbortSignal.any([signal, AbortSignal.timeout(45000)]),
                async () => (await authorize(job.scope)) === true,
              );
            }
          } catch (error) {
            if (!signal.aborted) diagnostic(error);
          }
        }
      } catch (error) {
        if (!signal.aborted) diagnostic(error);
      }
      await setTimeout(this.pollDelayMs, undefined, { signal }).catch(() => {});
    }
  }

  async run(
    scope: MediaJobScope,
    callId: string,
    prompt: string,
    signal: AbortSignal,
    authorize: () => Promise<void>,
    onCreated?: (jobId: string) => void,
  ) {
    const identity = this.reference(scope, callId, prompt);
    const check = async () => {
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
    };
    await check();
    let queued = await this.receipt(identity, "queued");
    if (!queued) {
      await this.executors.assertBound(scope.owner, scope.binding);
      if (!(await this.record(identity, { stage: "queued", scopeDigest: identity.scopeDigest })))
        queued = await this.receipt(identity, "queued");
    }
    if (queued?.scopeDigest && queued.scopeDigest !== identity.scopeDigest) throw new MediaExecutorError("conflict");
    if (queued && !queued.scopeDigest) await this.acknowledged(identity, scope);
    const jobId = referenceId(identity);
    if (!(await this.references.read(jobId).catch(absence))) await this.references.put(identity);
    onCreated?.(jobId);
    const previous = await this.result(identity);
    if (previous) return previous;
    await this.assertRunning(identity);

    let pending = await this.acknowledged(identity, scope);
    if (!pending) {
      if (!(await this.record(identity, { stage: "dispatch" }))) {
        const done = await this.result(identity);
        if (done) return done;
        pending = await this.acknowledged(identity, scope);
        if (!pending) {
          await this.assertRunning(identity);
          throw new MediaExecutorError("uncertain");
        }
      } else {
        await check();
        let started: MediaResult;
        this.submitting.add(identity.slot);
        try {
          started = await this.executors.submit(scope.owner, scope.binding, identity.slot, prompt, signal);
        } catch (error) {
          if (
            error instanceof MediaExecutorError &&
            ["authentication", "rateLimited", "notFound", "failed", "invalidInput", "invalidResult"].includes(
              error.code,
            )
          )
            await this.record(identity, { stage: "failed" });
          throw error;
        } finally {
          this.submitting.delete(identity.slot);
        }
        if (started.state === "succeeded") {
          await this.store(identity, started);
          await check();
          return (await this.result(identity))!;
        }
        pending = await this.acknowledge(identity, scope, started.taskId);
      }
    }

    while (true) {
      await check();
      const done = await this.result(identity);
      if (done) return done;
      await this.assertRunning(identity);
      await this.advance(pending, signal, check);
      await check();
      const ready = await this.result(identity);
      if (ready) return ready;
      await this.assertRunning(identity);
      await setTimeout(this.pollDelayMs, undefined, { signal });
    }
  }
}
