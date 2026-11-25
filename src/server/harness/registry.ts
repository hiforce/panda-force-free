import type {
  ApplicationRuntimePurpose,
  ApplicationRuntimeSelection,
  ApplicationRuntimeScope,
} from "../engines/application-tools/runtime-port.js";
import type { ApplicationToolEngine } from "../../shared/engine/application-tools.js";
import { randomUUID } from "node:crypto";
import {
  HarnessError,
  type HarnessCatalog,
  type HarnessPermissionMode,
  type HarnessRuntime,
  type HarnessRuntimeView,
  type HarnessProfileView,
} from "../../shared/harness/contracts.js";
import type {
  HarnessAgent,
  HarnessAgentFactory,
  HarnessMetadata,
  HarnessAgentInfo,
  HarnessNativeSession,
  HarnessApplicationPolicy,
} from "./ports.js";
import { decode, save } from "./records.js";
export interface HarnessProfile extends HarnessProfileView {
  factory: HarnessAgentFactory;
  conversationOnly?: boolean;
  applicationScopes?: readonly ApplicationRuntimeScope[];
  isolatedApplicationWorkspace?: boolean;
  applicationEngine?(
    selection: ApplicationRuntimeSelection,
    directory: string,
    purpose: ApplicationRuntimePurpose,
  ): ApplicationToolEngine;
  hostSocket?: boolean;
}
export interface HarnessPrincipal {
  owner: string;
  administrator: boolean;
}
interface Defaults {
  runtimeId: string;
  revision: number;
}
const runtimeKey = (id: string) => `runtime:${id}`;
/** Profiles are operator-owned execution capabilities. Browser configuration can only select an installed profile. */
export class HarnessRegistry {
  private readonly profiles = new Map<string, HarnessProfile>();
  private readonly discovered = new Map<string, HarnessAgentInfo>();
  private readonly failures = new Map<string, "authentication" | "unavailable">();
  constructor(
    readonly metadata: HarnessMetadata,
    profiles: readonly HarnessProfile[],
  ) {
    for (const profile of profiles) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(profile.id) || this.profiles.has(profile.id))
        throw new HarnessError("invalidInput");
      this.profiles.set(profile.id, profile);
    }
  }
  async initialize() {
    await this.metadata.transaction(async (tx) => {
      if (await tx.get("defaults")) return;
      const now = Date.now();
      const defaults: HarnessRuntime[] = [...this.profiles.values()].map((profile) => ({
        id: profile.id,
        name: profile.name,
        kind: profile.kind,
        profileId: profile.id,
        enabled: true,
        revision: 1,
        defaultModel: null,
        defaultEffort: null,
        access: "administrators",
        createdAt: now,
        updatedAt: now,
      }));
      if (!defaults.length) throw new HarnessError("unavailable", 503);
      for (const value of defaults) await save(tx, runtimeKey(value.id), "runtime", "application", value);
      await save(tx, "defaults", "defaults", "application", { runtimeId: defaults[0]!.id, revision: 1 });
    });
  }
  async require(principal: HarnessPrincipal, id: string) {
    const runtime = decode<HarnessRuntime>(await this.metadata.read(runtimeKey(id)));
    if (
      !runtime ||
      runtime.archivedAt ||
      !runtime.enabled ||
      (!principal.administrator && runtime.access !== "members")
    )
      throw new HarnessError("notFound", 404);
    if (!this.profiles.has(runtime.profileId)) throw new HarnessError("unavailable", 503);
    return runtime;
  }
  async catalog(principal: HarnessPrincipal): Promise<HarnessCatalog> {
    const defaults = decode<Defaults>(await this.metadata.read("defaults"));
    const values = (await this.metadata.list("runtime")).map((row) => decode<HarnessRuntime>(row)!);
    return {
      revision: defaults?.revision ?? 0,
      defaultRuntimeId: defaults?.runtimeId ?? "",
      canManage: principal.administrator,
      profiles: principal.administrator
        ? [...this.profiles.values()].map(
            ({
              factory: _factory,
              conversationOnly: _scope,
              applicationScopes: _applicationScopes,
              isolatedApplicationWorkspace: _isolated,
              applicationEngine: _applicationEngine,
              hostSocket: _socket,
              ...view
            }) => view,
          )
        : [],
      runtimes: values
        .filter(
          (runtime) =>
            !runtime.archivedAt && (principal.administrator || (runtime.enabled && runtime.access === "members")),
        )
        .map((runtime) => this.view(runtime, defaults?.runtimeId)),
    };
  }
  supportsApplication(profileId: string, scope?: ApplicationRuntimeScope) {
    const profile = this.profiles.get(profileId);
    return (
      !!profile &&
      (!profile.conversationOnly || (scope !== undefined && profile.applicationScopes?.includes(scope) === true))
    );
  }
  allowsApplication(runtime: HarnessRuntime, scope?: ApplicationRuntimeScope) {
    return this.supportsApplication(runtime.profileId, scope) && (scope !== "bots" || runtime.botEnabled !== false);
  }
  applicationEngine(profileId: string) {
    return this.profiles.get(profileId)?.applicationEngine;
  }
  isolatesApplicationWorkspace(profileId: string) {
    return this.profiles.get(profileId)?.isolatedApplicationWorkspace === true;
  }
  usesHostSocket(profileId: string) {
    return this.profiles.get(profileId)?.hostSocket === true;
  }
  view(runtime: HarnessRuntime, defaultId?: string): HarnessRuntimeView {
    const info = this.discovered.get(runtime.id),
      profile = this.profiles.get(runtime.profileId),
      error = this.failures.get(runtime.id);
    return {
      ...runtime,
      botEnabled: runtime.botEnabled !== false,
      botSupported: this.supportsApplication(runtime.profileId, "bots"),
      deployment: profile?.deployment ?? "local",
      isDefault: runtime.id === defaultId,
      status: error ?? (profile ? (info ? "ready" : "unknown") : "unavailable"),
      capabilities: info?.capabilities ?? null,
      models: info?.models ?? [],
      ...(error ? { error } : {}),
    };
  }
  async configure(
    principal: HarnessPrincipal,
    input: {
      id?: string;
      revision?: number;
      name: string;
      profileId: string;
      enabled: boolean;
      botEnabled?: boolean;
      defaultModel: string | null;
      defaultEffort: string | null;
      access: HarnessRuntime["access"];
      makeDefault?: boolean;
    },
  ) {
    if (!principal.administrator) throw new HarnessError("forbidden", 403);
    const profile = this.profiles.get(input.profileId);
    if (
      !profile ||
      !input.name.trim() ||
      input.name.length > 80 ||
      input.access !== "administrators" ||
      typeof input.enabled !== "boolean" ||
      (input.botEnabled !== undefined && typeof input.botEnabled !== "boolean")
    )
      throw new HarnessError("invalidInput");
    const id = input.id || randomUUID();
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new HarnessError("invalidInput");
    const model = this.discovered.get(id)?.models.find((model) => model.id === input.defaultModel);
    if (
      input.defaultModel &&
      (!model || (input.defaultEffort && !model.efforts.some((effort) => effort.id === input.defaultEffort)))
    )
      throw new HarnessError("invalidInput");
    if (input.defaultEffort && !input.defaultModel) throw new HarnessError("invalidInput");
    await this.metadata.transaction(async (tx) => {
      const previous = decode<HarnessRuntime>(await tx.get(runtimeKey(id)));
      if (previous?.archivedAt) throw new HarnessError("notFound", 404);
      if ((previous?.revision ?? 0) !== (input.revision ?? 0)) throw new HarnessError("conflict", 409);
      if (previous && previous.profileId !== profile.id) throw new HarnessError("conflict", 409);
      const defaults = decode<Defaults>(await tx.get("defaults"))!;
      if (!input.enabled && (defaults.runtimeId === id || input.makeDefault)) throw new HarnessError("conflict", 409);
      const value: HarnessRuntime = {
        id,
        name: input.name.trim(),
        profileId: profile.id,
        kind: profile.kind,
        enabled: input.enabled,
        botEnabled: input.botEnabled ?? previous?.botEnabled ?? true,
        defaultModel: input.defaultModel,
        defaultEffort: input.defaultEffort,
        access: input.access,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      await save(tx, runtimeKey(id), "runtime", "application", value);
      if (input.makeDefault) defaults.runtimeId = id;
      defaults.revision++;
      await save(tx, "defaults", "defaults", "application", defaults);
    });
    this.failures.delete(id);
    return this.catalog(principal);
  }
  async remove(principal: HarnessPrincipal, id: string, revision: number) {
    if (!principal.administrator) throw new HarnessError("forbidden", 403);
    await this.metadata.transaction(async (tx) => {
      const current = decode<HarnessRuntime>(await tx.get(runtimeKey(id)));
      if (!current) throw new HarnessError("notFound", 404);
      if (current.archivedAt && current.revision === revision + 1) return;
      const defaults = decode<Defaults>(await tx.get("defaults"))!;
      if (current.revision !== revision || defaults.runtimeId === id || current.archivedAt)
        throw new HarnessError("conflict", 409);
      const now = Date.now();
      await save(tx, runtimeKey(id), "runtime", "application", {
        ...current,
        archivedAt: now,
        enabled: false,
        revision: current.revision + 1,
        updatedAt: now,
      });
      await save(tx, "defaults", "defaults", "application", { ...defaults, revision: defaults.revision + 1 });
    });
    this.discovered.delete(id);
    this.failures.delete(id);
    return this.catalog(principal);
  }
  async agent(
    principal: HarnessPrincipal,
    id: string,
    scopeId: string,
    cwd: string,
    {
      application,
      permissionMode,
    }: { application?: HarnessApplicationPolicy; permissionMode?: HarnessPermissionMode } = {},
  ) {
    const runtime = await this.require(principal, id),
      profile = this.profiles.get(runtime.profileId)!;
    if (application && !this.allowsApplication(runtime, application.scope))
      throw new HarnessError("capabilityUnavailable", 409);
    try {
      const agent = await profile.factory.create(runtime, {
        owner: principal.owner,
        scopeId,
        cwd,
        application,
        permissionMode,
      });
      let info: HarnessAgentInfo;
      try {
        info = await agent.initialize();
        if (runtime.kind === "codex") this.discovered.set(id, info);
      } catch (error) {
        await agent.close();
        throw error;
      }
      const open = async (work: () => Promise<HarnessNativeSession>, discoverModels = false) => {
        try {
          const session = await work();
          // A live ACP session reports the selected model; its snapshot cannot replace a probed catalog.
          const usesAcpSession = runtime.kind === "claude-code" || runtime.kind === "antigravity";
          if (!usesAcpSession || discoverModels || !this.discovered.has(id))
            this.discovered.set(id, structuredClone(session.info ?? info));
          this.failures.delete(id);
          return session;
        } catch (error) {
          if (!(error instanceof HarnessError && error.code === "capabilityUnavailable"))
            this.failures.set(
              id,
              error instanceof HarnessError && error.code === "authentication" ? "authentication" : "unavailable",
            );
          throw error;
        }
      };
      const scoped: HarnessAgent = {
        initialize: async () => info,
        create: (cwd, options) => open(() => agent.create(cwd, options), options?.discoverModels),
        load: (nativeId, cwd, options) => open(() => agent.load(nativeId, cwd, options)),
        prompt: (session, input, emit) => agent.prompt(session, input, emit),
        cancel: (session) => agent.cancel(session),
        respondPermission: (permissionId, optionId) => agent.respondPermission(permissionId, optionId),
        close: () => agent.close(),
      };
      return { runtime, agent: scoped };
    } catch (error) {
      this.failures.set(
        id,
        error instanceof HarnessError && error.code === "authentication" ? "authentication" : "unavailable",
      );
      throw error;
    }
  }
  async probe(principal: HarnessPrincipal, id: string, cwd: string) {
    if (!principal.administrator) throw new HarnessError("forbidden", 403);
    const { agent } = await this.agent(principal, id, `probe-${randomUUID()}`, cwd);
    try {
      await agent.create(cwd, { discoverModels: true });
      return await this.catalog(principal);
    } finally {
      await agent.close();
    }
  }
}
