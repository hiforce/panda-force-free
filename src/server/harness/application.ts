import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { HarnessError, type HarnessRuntime } from "../../shared/harness/contracts.js";
import { runtimeModels, defaultRuntimeModel, supportedEffort } from "../../shared/engine/runtime-selection.js";
import type {
  ApplicationRuntimePort,
  ApplicationRuntimePurpose,
  ApplicationRuntimeSelection,
  ApplicationRuntimeScope,
} from "../engines/application-tools/runtime-port.js";
import type { ApplicationRunScope, ApplicationToolEngine } from "../../shared/engine/application-tools.js";
import type { HarnessRegistry, HarnessPrincipal } from "./registry.js";
import type { HarnessAgent } from "./ports.js";
import { harnessApplicationPrompts } from "./application-prompts.js";
import { applicationMcp } from "./application-mcp.js";
import { ActiveRunBudget, type RunBudgetClock } from "../engines/active-budget.js";
import { createHarnessWorkspace, harnessOutputReader } from "./workspaces.js";

/** Resolve every application selection against the same installed runtime registry used by conversations. */
export function applicationRuntimes(options: {
  registry: HarnessRegistry;
  scratchRoot: string;
  hostWorkspace?(): ReturnType<typeof createHarnessWorkspace>;
  principal(owner: string): Promise<HarnessPrincipal>;
  now?: () => number;
  runClock?: RunBudgetClock;
  codex(
    selection: ApplicationRuntimeSelection,
    directory: string,
    purpose: ApplicationRuntimePurpose,
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
  function directEngine(
    runtime: HarnessRuntime,
    selection: ApplicationRuntimeSelection,
    directory: string,
    purpose: ApplicationRuntimePurpose,
  ) {
    if (runtime.profileId === "codex") return options.codex(selection, directory, purpose);
    return options.registry.applicationEngine(runtime.profileId)?.(selection, directory, purpose);
  }
  const port: ApplicationRuntimePort = {
    async catalog(owner, scope = false) {
      const principal = await options.principal(owner);
      if (scope === true) return options.registry.catalog(principal);
      const catalog = await options.registry.catalog({ ...principal, administrator: true });
      const applicationScope = typeof scope === "string" ? scope : undefined;
      const runtimes = catalog.runtimes.filter(
        (runtime) =>
          options.registry.allowsApplication(runtime, applicationScope) &&
          (!applicationScope || runtime.enabled) &&
          (principal.administrator || (runtime.enabled && (runtime.id === "codex" || runtime.access === "members"))),
      );
      return {
        ...catalog,
        canManage: principal.administrator,
        profiles: principal.administrator
          ? catalog.profiles.filter((entry) => options.registry.supportsApplication(entry.id, applicationScope))
          : [],
        runtimes,
        defaultRuntimeId: runtimes.some((runtime) => runtime.id === catalog.defaultRuntimeId)
          ? catalog.defaultRuntimeId
          : (runtimes.find((runtime) => runtime.id === "codex")?.id ?? runtimes[0]?.id ?? ""),
      };
    },
    async discover(owner, id, scope = false) {
      const principal = scope === true ? await options.principal(owner) : await applicationPrincipal(owner, id);
      const configured = await options.registry.require(principal, id);
      const applicationScope = typeof scope === "string" ? scope : undefined;
      const scoped = options.registry.allowsApplication(configured, applicationScope);
      if (!scoped && scope !== true) throw new HarnessError("capabilityUnavailable", 409);
      const runtime = (await port.catalog(owner, scope)).runtimes.find((runtime) => runtime.id === id),
        key = JSON.stringify([owner, id, scope]),
        cached = checked.get(key),
        requestKey = JSON.stringify([owner, id, scope, configured.revision]),
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
        const hostSocket = options.registry.usesHostSocket(configured.profileId);
        if (hostSocket && !options.hostWorkspace) throw new HarnessError("workspaceUnavailable", 409);
        if (!hostSocket) await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
        const workspace = hostSocket
          ? await options.hostWorkspace!()
          : await createHarnessWorkspace(options.scratchRoot, "catalog-");
        const { cwd } = workspace;
        let bridge: Awaited<ReturnType<typeof applicationMcp>> | undefined;
        let agent: HarnessAgent | undefined;
        try {
          if (scoped)
            bridge = await applicationMcp(
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
          const opened = await options.registry.agent(
            principal,
            id,
            `catalog-${randomUUID()}`,
            cwd,
            bridge
              ? {
                  application: {
                    instructions: "Discover runtime capabilities only. No prompt is authorized.",
                    mcpServer: bridge.mcpServer,
                    scope: applicationScope,
                  },
                }
              : undefined,
          );
          agent = opened.agent;
          if (opened.runtime.kind !== "codex") await agent.create(cwd, { discoverModels: true });
          const current = await options.registry.require(principal, id);
          if (current.revision !== configured.revision) throw new HarnessError("conflict", 409);
          return (await port.catalog(owner, scope)).runtimes.find((runtime) => runtime.id === id)!;
        } finally {
          try {
            await agent?.close();
          } finally {
            try {
              await bridge?.close();
            } finally {
              await workspace.cleanup();
            }
          }
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
    async resolve(owner, selection, scope) {
      const id = selection.runtimeId || "codex";
      const configured = await options.registry.require(await applicationPrincipal(owner, id), id);
      if (!options.registry.allowsApplication(configured, scope)) throw new HarnessError("capabilityUnavailable", 409);
      const cached = (await port.catalog(owner, scope)).runtimes.find((runtime) => runtime.id === id),
        runtime = cached?.models.length && !cached.error ? cached : await port.discover(owner, id, scope),
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
      const runtimeId = selection.runtimeId || "codex",
        scopeName: ApplicationRuntimeScope | undefined =
          purpose === "bot-chat" ? "bots" : purpose === "bots" || purpose === "creation" ? purpose : undefined;
      if (runtimeId === "codex") {
        const engine = options.codex(selection, directory, purpose);
        return {
          ...engine,
          async run(input, callbacks) {
            const selected = await port.resolve(owner, selection, scopeName);
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
          const engine = directEngine(runtime, selection, directory, purpose);
          if (!engine) throw new HarnessError("invalidInput");
          await engine.forget?.(id);
        },
        async run(input, callbacks) {
          callbacks.signal.throwIfAborted();
          const configured = await options.registry.require(await options.principal(owner), runtimeId);
          if (!options.registry.allowsApplication(configured, scopeName))
            throw new HarnessError("capabilityUnavailable", 409);
          if (configured.profileId === "codex" || options.registry.applicationEngine(configured.profileId))
            return directEngine(configured, await port.resolve(owner, selection, scopeName), directory, purpose)!.run(
              input,
              callbacks,
            );
          let scope: ApplicationRunScope | null = null,
            agent: HarnessAgent | undefined;
          let toolCalls = 0;
          let resumeUpdates: (() => void) | undefined;
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
          let isolated: Awaited<ReturnType<typeof createHarnessWorkspace>> | undefined;
          signal.addEventListener("abort", abort, { once: true });
          try {
            if (options.registry.isolatesApplicationWorkspace(configured.profileId)) {
              if (options.registry.usesHostSocket(configured.profileId)) {
                if (!options.hostWorkspace) throw new HarnessError("workspaceUnavailable", 409);
                isolated = await options.hostWorkspace();
              } else {
                await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
                isolated = await createHarnessWorkspace(options.scratchRoot, "application-");
              }
            }
            const cwd = isolated?.cwd ?? directory;
            if (purpose === "creation" && isolated && callbacks.nativeFiles)
              callbacks.nativeFiles(await harnessOutputReader(cwd));
            bridge = await applicationMcp(
              input.tools,
              {
                ...callbacks,
                signal,
                async call(call) {
                  budget?.refresh();
                  const resume = budget?.hold();
                  toolCalls++;
                  try {
                    return await callbacks.call(call);
                  } finally {
                    budget?.refresh();
                    resume?.();
                    if (!--toolCalls) resumeUpdates?.();
                  }
                },
              },
              () => scope,
            );
            const opened = await options.registry.agent(
              await options.principal(owner),
              runtimeId,
              `application-${randomUUID()}`,
              cwd,
              {
                application: {
                  instructions: input.instructions,
                  mcpServer: bridge.mcpServer,
                  scope: scopeName,
                  nativeOutput: purpose === "creation" && !!isolated && !!callbacks.nativeFiles,
                  toolNames: input.tools.map(({ name }) => name),
                },
              },
            );
            agent = opened.agent;
            signal.throwIfAborted();
            const native = await agent.create(cwd, { permissionMode: "always-approve" });
            signal.throwIfAborted();
            const { model, effort } = await port.resolve(owner, selection, scopeName);
            scope = { sessionId: "app-" + randomUUID(), runId: randomUUID() };
            await callbacks.session?.(scope.sessionId);
            await callbacks.started(scope);
            signal.throwIfAborted();
            return await harnessApplicationPrompts({
              agent,
              native,
              scope,
              callbacks,
              signal,
              prompt: input.prompt,
              model,
              effort: effort || null,
              creation: purpose === "creation",
              toolBusy: () => toolCalls > 0,
              onToolIdle: (wake) => {
                resumeUpdates = wake;
              },
              activity: () => budget?.refresh(),
            });
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
            try {
              await agent?.close();
            } finally {
              try {
                await bridge?.close();
              } finally {
                await isolated?.cleanup();
              }
            }
          }
        },
      };
    },
  };
  return port;
}
