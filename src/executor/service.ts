import { verifyBuildTheme, BuildThemeError } from "../shared/builds/theme.js";
import { verifyBuildProject } from "../shared/builds/project.js";
import type { BuildInput, BuildExecutor } from "../shared/builds/contracts.js";
import { buildInput, BuildError } from "../shared/builds/validation.js";
import type { ExecutionDriver } from "./driver.js";
import type { ExecutionStore } from "./store.js";
import { ResourceBuildRequest } from "../shared/builds/resources.js";

/** Durable request state is separate from container lifecycle; a restart never silently republishes work. */
export class ExecutionService implements BuildExecutor {
  private active = new Map<string, AbortController>();
  private pending: string[] = [];
  private closed = false;
  constructor(
    readonly store: ExecutionStore,
    private driver: ExecutionDriver,
    private report: (event: object) => void,
  ) {}
  async recover() {
    await this.driver.ready?.();
    for (const id of this.store.ids()) {
      const state = this.store.get(id);
      await this.driver.cleanup(id);
      if (!["completed", "failed"].includes(state.phase)) {
        this.store.update(id, { phase: "failed", error: "executorRestarted" });
      }
    }
    this.store.prune();
  }
  async start(id: string, input: BuildInput) {
    if (this.closed) throw new BuildError("executorStopping", 503);
    const normalized = buildInput(input);
    if (normalized.project) await verifyBuildProject(normalized.project);
    if (normalized.theme) {
      try {
        await verifyBuildTheme(normalized.theme, normalized.engine);
      } catch (error) {
        if (error instanceof BuildThemeError) throw new BuildError(error.message);
        throw error;
      }
    }
    const record = this.store.create(id, normalized);
    return this.schedule(id, record.phase);
  }
  async startResource(id: string, input: ResourceBuildRequest) {
    if (this.closed) throw new BuildError("executorStopping", 503);
    if (!(input instanceof ResourceBuildRequest)) throw new BuildError("invalidResourceBuild");
    if (input.descriptor.input.project) await verifyBuildProject(input.descriptor.input.project);
    if (this.closed) throw new BuildError("executorStopping", 503);
    const record = this.store.createResource(id, input);
    return this.schedule(id, record.phase);
  }
  private schedule(id: string, phase: string) {
    if (phase === "queued" && !this.pending.includes(id) && !this.active.has(id)) {
      this.pending.push(id);
      this.pump();
    }
    return this.store.get(id);
  }
  private pump() {
    if (this.closed || this.active.size || !this.pending.length) return;
    const id = this.pending.shift()!,
      controller = new AbortController();
    this.active.set(id, controller);
    void this.execute(id, controller).finally(() => {
      this.active.delete(id);
      this.pump();
    });
  }
  private async execute(id: string, controller: AbortController) {
    this.report({ event: "build.started", id });
    try {
      const artifact = await this.driver.run(
        id,
        await this.store.request(id),
        controller.signal,
        (change) => this.store.update(id, change),
        (logs) => this.store.logs(id, logs),
      );
      if (controller.signal.aborted) throw new BuildError("cancelled", 409);
      this.store.complete(id, artifact);
      this.report({ event: "build.completed", id, bytes: artifact.bytes });
    } catch (error) {
      const code = controller.signal.aborted ? "cancelled" : error instanceof BuildError ? error.code : "buildFailed";
      this.store.update(id, { phase: "failed", error: code });
      this.report({ event: "build.failed", id, code });
    }
  }
  async status(id: string) {
    return this.store.get(id);
  }
  async ready() {
    if (this.closed) throw new BuildError("executorStopping", 503);
    await this.driver.ready?.();
  }
  async result(id: string) {
    return this.store.result(id);
  }
  async cancel(id: string) {
    const state = this.store.get(id);
    if (["completed", "failed"].includes(state.phase)) return state;
    this.pending = this.pending.filter((value) => value !== id);
    const controller = this.active.get(id);
    if (controller) controller.abort();
    else this.store.update(id, { phase: "failed", error: "cancelled" });
    return this.store.get(id);
  }
  close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
  }
}
