import { randomUUID } from "node:crypto";
import {
  HarnessError,
  HarnessPromptError,
  type HarnessPingResult,
  type HarnessRuntime,
} from "../../shared/harness/contracts.js";
import type { HarnessAgent } from "./ports.js";
import { HarnessRegistry, type HarnessPrincipal } from "./registry.js";

/** Explicit model diagnostics use isolated workspaces and never append to conversation history. */
export class HarnessDiagnostics {
  private readonly requests = new Map<
    string,
    { runtimeId: string; at: number; settled: boolean; promise: Promise<HarnessPingResult> }
  >();
  private readonly owners = new Set<string>();
  private readonly agents = new Set<HarnessAgent>();
  private closed = false;
  constructor(
    private readonly registry: HarnessRegistry,
    private readonly workspace: (runtime: HarnessRuntime) => Promise<{ cwd: string; cleanup(): Promise<void> }>,
    private readonly timeoutMs = 60000,
  ) {}
  async ping(principal: HarnessPrincipal, runtimeId: string, requestId: string): Promise<HarnessPingResult> {
    if (!principal.administrator) throw new HarnessError("forbidden", 403);
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new HarnessError("invalidInput");
    if (this.closed) throw new HarnessError("unavailable", 503);
    const key = `${principal.owner}\0${requestId}`;
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.runtimeId !== runtimeId) throw new HarnessError("conflict", 409);
      return previous.promise;
    }
    for (const [id, entry] of this.requests)
      if (entry.settled && entry.at < Date.now() - 10 * 60 * 1000) this.requests.delete(id);
    if (this.owners.has(principal.owner) || this.owners.size >= 4 || this.requests.size >= 128)
      throw new HarnessError("busy", 409);
    this.owners.add(principal.owner);
    const entry = {
      runtimeId,
      at: Date.now(),
      settled: false,
      promise: this.execute(principal, runtimeId, requestId),
    };
    this.requests.set(key, entry);
    void entry.promise.finally(() => {
      entry.settled = true;
      this.owners.delete(principal.owner);
    });
    return entry.promise;
  }
  private async execute(principal: HarnessPrincipal, runtimeId: string, requestId: string): Promise<HarnessPingResult> {
    const started = Date.now();
    let agent: HarnessAgent | undefined,
      workspace: Awaited<ReturnType<HarnessDiagnostics["workspace"]>> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      dispatched = false,
      reply = "",
      model: string | null = null,
      toolRequested = false;
    const result = (status: HarnessPingResult["status"], error?: HarnessPingResult["error"]): HarnessPingResult => ({
      requestId,
      runtimeId,
      status,
      reply: reply.trim(),
      model,
      elapsedMs: Date.now() - started,
      ...(error ? { error } : {}),
    });
    try {
      const runtime = await this.registry.require(principal, runtimeId);
      workspace = await this.workspace(runtime);
      ({ agent } = await this.registry.agent(principal, runtimeId, `ping-${requestId}`, workspace.cwd));
      this.agents.add(agent);
      if (this.closed) throw new HarnessError("unavailable", 503);
      const initial = await agent.initialize(),
        session = await agent.create(workspace.cwd),
        info = session.info ?? initial;
      const selected = info.models.find((value) => value.id === (runtime.defaultModel ?? info.currentModel));
      model = runtime.defaultModel ?? selected?.id ?? null;
      if (
        (runtime.defaultModel && !selected) ||
        (runtime.defaultEffort && !selected?.efforts.some((value) => value.id === runtime.defaultEffort))
      )
        throw new HarnessPromptError("invalidInput", false, 400);
      const activeAgent = agent;
      dispatched = true;
      const work = agent.prompt(
        session,
        {
          text: "hi\nReply with a short greeting only. Do not use tools or read or modify files.",
          attachments: [],
          model,
          effort: runtime.defaultEffort,
          operationId: randomUUID(),
        },
        async (event) => {
          if (event.type === "text") reply = (reply + event.text).slice(0, 2000);
          else if (event.type === "permission") {
            toolRequested = true;
            await activeAgent.respondPermission(event.id, null);
          } else if (event.type === "tool") {
            toolRequested = true;
            await activeAgent.cancel(session);
          }
        },
      );
      const completed = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HarnessError("timeout", 504)), this.timeoutMs);
        }),
      ]);
      if (toolRequested) return result("error", "capabilityUnavailable");
      if (completed.stopReason !== "complete" || !reply.trim()) return result("uncertain", "deliveryUncertain");
      return result("complete");
    } catch (error) {
      const uncertain = error instanceof HarnessPromptError ? error.dispatched : dispatched;
      return result(
        uncertain ? "uncertain" : "error",
        error instanceof HarnessError ? error.code : uncertain ? "deliveryUncertain" : "unavailable",
      );
    } finally {
      if (timer) clearTimeout(timer);
      await agent?.close().catch(() => {});
      if (agent) this.agents.delete(agent);
      await workspace?.cleanup().catch(() => {});
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.agents].map((agent) => agent.close()));
    await Promise.allSettled([...this.requests.values()].map((entry) => entry.promise));
  }
}
