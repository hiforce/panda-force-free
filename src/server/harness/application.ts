import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "../../shared/harness/contracts.js";
import { runtimeModels, defaultRuntimeModel, supportedEffort } from "../../shared/engine/runtime-selection.js";
import type { ApplicationRuntimePort, ApplicationRuntimeSelection } from "../engines/application-tools/runtime-port.js";
import type { ApplicationRunScope, ApplicationToolEngine } from "../../shared/engine/application-tools.js";
import type { HarnessRegistry, HarnessPrincipal } from "./registry.js";
import type { HarnessAgent } from "./ports.js";
import { applicationMcp } from "./application-mcp.js";
import { ActiveRunBudget, type RunBudgetClock } from "../engines/active-budget.js";

/** Resolve every application selection against the same installed runtime registry used by conversations. */
export function applicationRuntimes(options: {
  registry: HarnessRegistry;
  scratchRoot: string;
  principal(owner: string): Promise<HarnessPrincipal>;
  now?: () => number;
  runClock?: RunBudgetClock;
  codex(
    selection: ApplicationRuntimeSelection,
    directory: string,
    purpose: "bots" | "bot-chat" | "creation" | "knowledge" | "editorial",
  ): ApplicationToolEngine;
}): ApplicationRuntimePort {
  // Members already use the built-in Codex application engine. This exception grants only its
  // read-only catalog and scoped application port; native workspace/session routes keep registry authorization.
  const applicationPrincipal = async (owner: string, id: string) => {
    const principal = await options.principal(owner);
    return id === "codex" ? { ...principal, administrator: true } : principal;
  };
  const discovering = new Map<string, Promise<import("../../shared/harness/contracts.js").HarnessRuntimeView>>();
  const checked = new Map<string, { revision: number; expiresAt: number }>();
  const now = options.now ?? Date.now;
  const port: ApplicationRuntimePort = {
    async catalog(owner, conversation = false) {
      const principal = await options.principal(owner);
      if (conversation) return options.registry.catalog(principal);
      const catalog = await options.registry.catalog({ ...principal, administrator: true });
      const runtimes = catalog.runtimes.filter(
        (runtime) =>
          options.registry.supportsApplication(runtime.profileId) &&
          (principal.administrator || (runtime.enabled && (runtime.id === "codex" || runtime.access === "members"))),
      );
      return {
        ...catalog,
        canManage: principal.administrator,
        profiles: principal.administrator
          ? catalog.profiles.filter((entry) => options.registry.supportsApplication(entry.id))
          : [],
        runtimes,
        defaultRuntimeId: runtimes.some((runtime) => runtime.id === catalog.defaultRuntimeId)
          ? catalog.defaultRuntimeId
          : (runtimes.find((runtime) => runtime.id === "codex")?.id ?? runtimes[0]?.id ?? ""),
      };
    },
    async discover(owner, id, conversation = false) {
      const principal = conversation ? await options.principal(owner) : await applicationPrincipal(owner, id);
      const configured = await options.registry.require(principal, id);
      const scoped = options.registry.supportsApplication(configured.profileId);
      if (!scoped && !conversation) throw new HarnessError("capabilityUnavailable", 409);
      const runtime = (await port.catalog(owner, conversation)).runtimes.find((runtime) => runtime.id === id),
        key = JSON.stringify([owner, id]),
        cached = checked.get(key),
        requestKey = JSON.stringify([owner, id, configured.revision]),
        previous = discovering.get(requestKey);
      // Authorization is checked on every read; only successful capability discovery is reused.
      if (
        cached &&
        cached.revision === configured.revision &&
        cached.expiresAt > now() &&
        runtime?.revision === configured.revision &&
        runtime.enabled &&
        runtime?.status === "ready" &&
        runtime.models.length
      )
        return runtime;
      if (previous) {
        const result = await previous;
        const current = await options.registry.require(principal, id);
        if (current.revision !== configured.revision) throw new HarnessError("conflict", 409);
        return result;
      }
      checked.delete(key);
      const work = (async () => {
        await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
        const cwd = await mkdtemp(join(options.scratchRoot, "catalog-"));
        const bridge = await applicationMcp(
          [],
          {
            signal: new AbortController().signal,
            started() {},
            call: async () => {
              throw new HarnessError("forbidden", 403);
            },
          },
          () => null,
        );
        let agent: HarnessAgent | undefined;
        try {
          const opened = await options.registry.agent(
            principal,
            id,
            `catalog-${randomUUID()}`,
            cwd,
            scoped
              ? {
                  application: {
                    instructions: "Discover runtime capabilities only. No prompt is authorized.",
                    mcpServer: bridge.mcpServer,
                  },
                }
              : undefined,
          );
          agent = opened.agent;
          if (opened.runtime.kind !== "codex") await agent.create(cwd, { discoverModels: true });
          const current = await options.registry.require(principal, id);
          if (current.revision !== configured.revision) throw new HarnessError("conflict", 409);
          return (await port.catalog(owner, conversation)).runtimes.find((runtime) => runtime.id === id)!;
        } finally {
          await agent?.close();
          await bridge.close();
          await rm(cwd, { recursive: true, force: true });
        }
      })();
      discovering.set(requestKey, work);
      try {
        const discovered = await work;
        const current = await options.registry.require(principal, id);
        if (current.revision !== configured.revision) throw new HarnessError("conflict", 409);
        if (discovered.status === "ready" && discovered.models.length) {
          checked.set(key, { revision: current.revision, expiresAt: now() + 300000 });
          if (checked.size > 128) checked.delete(checked.keys().next().value!);
        }
        return discovered;
      } finally {
        discovering.delete(requestKey);
      }
    },
    async resolve(owner, selection) {
      const id = selection.runtimeId || "codex";
      const configured = await options.registry.require(await applicationPrincipal(owner, id), id);
      if (!options.registry.supportsApplication(configured.profileId))
        throw new HarnessError("capabilityUnavailable", 409);
      const cached = (await port.catalog(owner)).runtimes.find((runtime) => runtime.id === id),
        runtime = cached?.models.length && !cached.error ? cached : await port.discover(owner, id),
        models = runtimeModels(runtime),
        model = selection.model || defaultRuntimeModel(runtime);
      if (!model || !models.some((entry) => entry.id === model)) throw new HarnessError("invalidInput");
      const selected = models.find((entry) => entry.id === model)!,
        efforts = selected.efforts.map((entry) => entry.id);
      if (selection.effort && !efforts.includes(selection.effort)) throw new HarnessError("invalidInput");
      const effort = supportedEffort(efforts, selection.effort, selected.defaultEffort);
      return { runtimeId: id, model, effort: effort || "" };
    },
    engine(owner, selection, directory, purpose) {
      const runtimeId = selection.runtimeId || "codex";
      if (runtimeId === "codex") {
        const engine = options.codex(selection, directory, purpose);
        return {
          ...engine,
          async run(input, callbacks) {
            const selected = await port.resolve(owner, selection);
            return options.codex(selected, directory, purpose).run(input, callbacks);
          },
        };
      }
      return {
        id: `harness-${runtimeId}`,
        persistentSession: false,
        async forget(id) {
          if (id.startsWith("app-")) return;
          const runtime = await options.registry.require(await options.principal(owner), runtimeId);
          if (runtime.kind !== "codex") throw new HarnessError("invalidInput");
          await options.codex(selection, directory, purpose).forget?.(id);
        },
        async run(input, callbacks) {
          callbacks.signal.throwIfAborted();
          const configured = await options.registry.require(await options.principal(owner), runtimeId);
          if (!options.registry.supportsApplication(configured.profileId))
            throw new HarnessError("capabilityUnavailable", 409);
          if (configured.kind === "codex")
            return options.codex(await port.resolve(owner, selection), directory, purpose).run(input, callbacks);
          let scope: ApplicationRunScope | null = null,
            agent: HarnessAgent | undefined,
            text = "";
          const inactive = new AbortController(),
            budget =
              purpose === "creation"
                ? new ActiveRunBudget(600000, () => inactive.abort(), options.runClock)
                : undefined,
            timeout = budget ? inactive.signal : AbortSignal.timeout(180000),
            signal = AbortSignal.any([callbacks.signal, timeout]),
            abort = () => {
              void agent?.close().catch(() => {});
            };
          let bridge: Awaited<ReturnType<typeof applicationMcp>> | undefined;
          signal.addEventListener("abort", abort, { once: true });
          try {
            bridge = await applicationMcp(
              input.tools,
              {
                ...callbacks,
                signal,
                async call(call) {
                  budget?.refresh();
                  const resume = budget?.hold();
                  try {
                    return await callbacks.call(call);
                  } finally {
                    budget?.refresh();
                    resume?.();
                  }
                },
              },
              () => scope,
            );
            const opened = await options.registry.agent(
              await options.principal(owner),
              runtimeId,
              `application-${randomUUID()}`,
              directory,
              {
                application: { instructions: input.instructions, mcpServer: bridge.mcpServer },
              },
            );
            agent = opened.agent;
            signal.throwIfAborted();
            const native = await agent.create(directory, { permissionMode: "always-approve" });
            signal.throwIfAborted();
            const { model, effort } = await port.resolve(owner, selection);
            scope = { sessionId: "app-" + randomUUID(), runId: randomUUID() };
            await callbacks.session?.(scope.sessionId);
            await callbacks.started(scope);
            signal.throwIfAborted();
            const result = await agent.prompt(
              native,
              { text: input.prompt, attachments: [], model, effort: effort || null, operationId: scope.runId },
              async (event) => {
                signal.throwIfAborted();
                if (["activity", "text", "tool", "usage"].includes(event.type)) budget?.refresh();
                if (event.type === "permission") {
                  // Native actions are absent from the curated application profile; never grant a fallback action.
                  await agent!.respondPermission(event.id, null);
                  throw new HarnessError("capabilityUnavailable");
                }
                if (event.type === "text") {
                  text = (text + event.text).slice(0, 64000);
                  await callbacks.event?.({ kind: "message", id: scope!.runId, text, complete: false });
                }
              },
            );
            signal.throwIfAborted();
            if (text.trim()) {
              await callbacks.event?.({
                kind: "message",
                id: scope.runId,
                text,
                complete: true,
                phase: "final_answer",
              });
              await callbacks.message?.(text);
            }
            return { ...scope, status: result.stopReason === "complete" ? "completed" : "interrupted" };
          } catch (error) {
            // Closing ACP after the deadline can surface as a transport failure. Keep the
            // application deadline distinct from user cancellation and engine disconnects.
            if (timeout.aborted && !callbacks.signal.aborted)
              throw Object.assign(
                new Error(budget ? "Application engine inactive" : "Application engine deadline exceeded"),
                {
                  code: budget ? "APPLICATION_ENGINE_INACTIVE" : "APPLICATION_ENGINE_DEADLINE",
                },
              );
            throw error;
          } finally {
            budget?.close();
            signal.removeEventListener("abort", abort);
            await agent?.close();
            await bridge?.close();
          }
        },
      };
    },
  };
  return port;
}
