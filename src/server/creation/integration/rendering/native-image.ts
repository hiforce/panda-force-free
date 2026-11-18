import { join, isAbsolute, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { isRecord } from "../../../../shared/records.js";
import type { CodexConnection, CodexTransport, CodexTransportFactory } from "../../../engines/codex-transport.js";
import { createCodexBridge } from "../../../bridge/codex-process.js";
import { registerApplicationRoot, rememberApplicationSession } from "../../../engines/application-tools/sessions.js";
import { creationRecord, creationUuid } from "../../validation.js";
import {
  ImageRenderError,
  type ImageRenderBinding,
  type ImageRenderIntent,
  type ImageRenderRequest,
  type ImageRenderResult,
} from "./image-contracts.js";
import { ImageRenderJournal, imageRenderIntent } from "./image-journal.js";
import { nativeImagePolicy, rendererDirectory, IMAGE_RENDER_PROFILE } from "./image-policy.js";
import { nativeImageResult } from "./image-result.js";

interface Callbacks {
  signal: AbortSignal;
  authorize(): Promise<void>;
}
interface Options {
  connection: CodexConnection;
  scratchRoot: string;
  version: string;
  timeoutMs?: number;
}
function binding(root: string, raw: unknown): ImageRenderBinding {
  const value = creationRecord(raw, ["threadId", "directory"]);
  if (typeof value.directory !== "string") throw new ImageRenderError("invalidInput");
  return { threadId: creationUuid(value.threadId), directory: rendererDirectory(root, value.directory) };
}
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
function waitForImage<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** Native rendering owns no public URL or document identity. Durable dispatch is reconciled before any retry. */
export class NativeImageRenderer {
  private readonly pending = new Map<string, { signature: string; work: Promise<ImageRenderResult> }>();
  private readiness: { at: number; value: boolean } | undefined;
  private probing: Promise<boolean> | undefined;
  constructor(
    private readonly journal: ImageRenderJournal,
    private readonly options: Options,
    private readonly factory: CodexTransportFactory = createCodexBridge,
  ) {
    if (
      !isAbsolute(options.scratchRoot) ||
      resolve(options.scratchRoot) !== options.scratchRoot ||
      dirname(options.scratchRoot) === options.scratchRoot ||
      !Number.isSafeInteger(options.timeoutMs ?? 360000) ||
      (options.timeoutMs ?? 360000) < 1000 ||
      (options.timeoutMs ?? 360000) > 600000
    )
      throw new ImageRenderError("invalidInput");
    registerApplicationRoot(options.scratchRoot);
  }
  available(): Promise<boolean> {
    if (this.readiness && Date.now() - this.readiness.at < 30000) return Promise.resolve(this.readiness.value);
    return (this.probing ??= this.probe()
      .then((value) => {
        this.readiness = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.probing = undefined;
      }));
  }
  private async probe() {
    let closing = false;
    try {
      await this.prepareLocalRoot();
    } catch {
      return false;
    }
    const transport = this.factory({
      connection: this.options.connection,
      defaultCwd: this.options.scratchRoot,
      clientInfo: {
        name: "panda-image-capabilities",
        title: "PandaForce image capabilities",
        version: this.options.version,
      },
      isShuttingDown: () => closing,
      onConnected() {},
      onDisconnected() {},
      onMessage() {},
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        transport.request("modelProvider/capabilities/read", {}),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ImageRenderError("unavailable")), 2500);
        }),
      ]);
      return isRecord(value) && value.imageGeneration === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      closing = true;
      transport.cancelRestart();
      transport.rejectPending(new ImageRenderError("unavailable"));
      transport.terminate();
    }
  }
  private async prepareLocalRoot() {
    if (this.options.connection.mode === "shared") return;
    await mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.scratchRoot);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(this.options.scratchRoot)) !== this.options.scratchRoot
    )
      throw new ImageRenderError("unavailable");
  }
  async render(value: ImageRenderRequest, callbacks: Callbacks) {
    callbacks.signal.throwIfAborted();
    const input = structuredClone(value),
      intent = await imageRenderIntent(input);
    await callbacks.authorize();
    callbacks.signal.throwIfAborted();
    const pending = this.pending.get(intent.key);
    if (pending && pending.signature !== intent.signature) throw new ImageRenderError("conflict");
    if (!pending && this.pending.size >= 2) throw new ImageRenderError("busy");
    const work = pending?.work ?? this.execute(intent, input, callbacks).finally(() => this.pending.delete(intent.key));
    if (!pending) this.pending.set(intent.key, { signature: intent.signature, work });
    // The owner retains its resource slot until its real operation and cleanup stop; a duplicate waiter may leave early.
    const result = await (pending ? waitForImage(work, callbacks.signal) : work);
    await callbacks.authorize();
    callbacks.signal.throwIfAborted();
    return { ...result, bytes: Buffer.from(result.bytes) };
  }
  private async execute(intent: ImageRenderIntent, input: ImageRenderRequest, callbacks: Callbacks) {
    await this.prepareLocalRoot();
    await this.journal.insert(intent, "intent", intent);
    const saved = await this.journal.receipt(intent);
    if (saved) return saved;
    let closing = false,
      transport!: CodexTransport,
      owned: ImageRenderBinding | null = null,
      turnId: string | null = null,
      terminal = false,
      interrupt = false,
      provisional: ImageRenderBinding | null = null;
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 360000),
      signal = AbortSignal.any([callbacks.signal, deadline]);
    const abort = () => transport.rejectPending(new ImageRenderError("uncertain"));
    transport = this.factory({
      connection: this.options.connection,
      defaultCwd: this.options.scratchRoot,
      clientInfo: { name: "panda-image-renderer", title: "PandaForce image renderer", version: this.options.version },
      isShuttingDown: () => closing,
      onConnected() {},
      onDisconnected() {},
      onMessage(message) {
        if (message.id !== undefined && message.method && !closing && transport.connected)
          transport.sendRaw({
            id: message.id,
            error: { code: -32601, message: "This renderer permits only native image generation." },
          });
      },
    });
    signal.addEventListener("abort", abort, { once: true });
    const request = async (method: string, params: Record<string, unknown>) => {
      signal.throwIfAborted();
      const result = await transport.request(method, params);
      signal.throwIfAborted();
      return result;
    };
    try {
      const known = await this.journal.read(intent, "binding");
      if (known) owned = binding(this.options.scratchRoot, known);
      else {
        const directory = rendererDirectory(
          this.options.scratchRoot,
          join(this.options.scratchRoot, "image-" + randomUUID()),
        );
        await request("fs/createDirectory", { path: directory, recursive: true });
        const started = await request("thread/start", nativeImagePolicy(directory, intent));
        if (!isRecord(started) || !isRecord(started.thread)) throw new ImageRenderError("unavailable");
        const threadId = creationUuid(started.thread.id);
        rememberApplicationSession(threadId);
        provisional = { threadId, directory };
        if (
          !isRecord(started.activePermissionProfile) ||
          started.activePermissionProfile.id !== IMAGE_RENDER_PROFILE ||
          started.approvalPolicy !== "never" ||
          started.cwd !== directory
        )
          throw new ImageRenderError("unavailable");
        await this.journal.insert(intent, "binding", { threadId, directory });
        owned = binding(this.options.scratchRoot, await this.journal.read(intent, "binding"));
        if (owned.threadId !== threadId) {
          await request("thread/unsubscribe", { threadId });
          await request("fs/remove", { path: directory, recursive: true, force: false });
        }
        provisional = null;
      }
      rememberApplicationSession(owned.threadId);
      await callbacks.authorize();
      signal.throwIfAborted();
      // The winner alone dispatches. A crash after this durable claim is uncertain, never an automatic new inference.
      const dispatch = await this.journal.insert(intent, "dispatch", { threadId: owned.threadId });
      if (dispatch) {
        try {
          const response = await request("turn/start", {
            threadId: owned.threadId,
            input: [
              { type: "text", text: intent.prompt },
              ...(input.images ?? []).map((bytes, index) => ({
                type: "image",
                url: "data:" + intent.inputs[index]!.mime + ";base64," + Buffer.from(bytes).toString("base64"),
              })),
            ],
            ...(intent.profile.effort ? { effort: intent.profile.effort } : {}),
          });
          if (isRecord(response) && isRecord(response.turn)) turnId = creationUuid(response.turn.id);
        } catch {
          signal.throwIfAborted();
          // A timed-out write acknowledgment does not prove that inference was rejected.
        }
      }
      let readFailures = 0,
        authorizedAt = performance.now();
      for (;;) {
        signal.throwIfAborted();
        if (performance.now() - authorizedAt >= 3000) {
          await callbacks.authorize();
          authorizedAt = performance.now();
        }
        let response: unknown;
        try {
          response = await request("thread/read", { threadId: owned.threadId, includeTurns: true });
          readFailures = 0;
        } catch {
          signal.throwIfAborted();
          // Polling is read-only. Reconnect and inspect this same owned turn before returning an uncertain result.
          if (++readFailures >= 3) throw new ImageRenderError("uncertain");
          await pause(signal);
          continue;
        }
        if (
          !isRecord(response) ||
          !isRecord(response.thread) ||
          response.thread.id !== owned.threadId ||
          !Array.isArray(response.thread.turns)
        )
          throw new ImageRenderError("uncertain");
        const turns = response.thread.turns;
        if (turns.length > 1) throw new ImageRenderError("invalidResult");
        const turn = turns[0];
        if (isRecord(turn)) {
          const observed = creationUuid(turn.id);
          if (turnId && observed !== turnId) throw new ImageRenderError("invalidResult");
          turnId = observed;
          if (["completed", "failed", "interrupted"].includes(String(turn.status))) {
            terminal = true;
            if (turn.status !== "completed") throw new ImageRenderError("invalidResult");
            const result = await nativeImageResult(turn);
            await callbacks.authorize();
            signal.throwIfAborted();
            const { bytes, ...metadata } = result;
            return await this.journal.save(intent, bytes, { ...metadata, threadId: owned.threadId, turnId });
          }
        }
        await pause(signal);
      }
    } catch (error) {
      interrupt = !(error instanceof ImageRenderError && error.code === "uncertain");
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      const cleanup = async () => {
        if (owned && !terminal && !turnId && transport.connected) {
          // Cancellation may arrive before the turn/start acknowledgment. Inspect only this owned thread.
          try {
            const state = await transport.request("thread/read", { threadId: owned.threadId, includeTurns: true });
            if (
              isRecord(state) &&
              isRecord(state.thread) &&
              state.thread.id === owned.threadId &&
              Array.isArray(state.thread.turns) &&
              state.thread.turns.length === 1
            ) {
              const turn = state.thread.turns[0];
              if (isRecord(turn)) {
                turnId = creationUuid(turn.id);
                terminal = ["completed", "failed", "interrupted"].includes(String(turn.status));
              }
            }
          } catch {
            /* An uncertain render remains bound to its journal for later reconciliation. */
          }
        }
        if (owned && !terminal && turnId && transport.connected && (signal.aborted || interrupt))
          await transport.request("turn/interrupt", { threadId: owned.threadId, turnId }).catch(() => {});
        if (provisional && provisional.threadId !== owned?.threadId && transport.connected) {
          await transport
            .request("fs/remove", { path: provisional.directory, recursive: true, force: false })
            .catch(() => {});
          await transport.request("thread/unsubscribe", { threadId: provisional.threadId }).catch(() => {});
        }
        if (owned && transport.connected) {
          if (terminal)
            await transport
              .request("fs/remove", { path: owned.directory, recursive: true, force: false })
              .catch(() => {});
          await transport.request("thread/unsubscribe", { threadId: owned.threadId }).catch(() => {});
        }
      };
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, 2000);
        }),
      ]);
      clearTimeout(cleanupTimer);
      closing = true;
      transport.cancelRestart();
      transport.rejectPending(new ImageRenderError("uncertain"));
      transport.terminate();
    }
  }
}
