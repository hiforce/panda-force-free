import {
  GadgetError,
  GADGET_LIMITS,
  type GadgetManifest,
  type GadgetConfig,
  type GadgetLayout,
} from "../../shared/gadget/contracts.js";
import { validateGadgetConfig } from "../../shared/gadget/layout.js";
import { REQUIRED_LOCALE_CODES } from "../../shared/i18n/locale-policy.js";
export interface GadgetServiceContext {
  readonly owner: string;
  readonly signal: AbortSignal;
  readonly instanceId: string;
  readonly config: Readonly<GadgetConfig>;
}
export interface GadgetService {
  authorize(context: GadgetServiceContext): boolean | Promise<boolean>;
  handle(context: GadgetServiceContext, input: unknown): unknown | Promise<unknown>;
}
export interface GadgetModule {
  manifest: GadgetManifest;
  services: Record<string, GadgetService>;
  actions?: Record<string, GadgetService>;
  /** A package-owned, bundled frontend. Never a client-selected URL. */
  frontend?: string;
  dispose?(): void | Promise<void>;
  migrations?: Record<number, (config: GadgetConfig) => GadgetConfig>;
}
/** The host does not know component IDs, service names or application-specific query implementations. */
export class GadgetRegistry {
  private modules = new Map<string, GadgetModule>();
  private active = new Map<string, number>();
  private total = 0;
  private closed = false;
  register(module: GadgetModule) {
    const m = module.manifest;
    if (
      !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(m.id) ||
      this.modules.has(m.id) ||
      m.apiVersion !== 1 ||
      !Number.isSafeInteger(m.configVersion) ||
      m.configVersion < 1 ||
      !m.version ||
      !REQUIRED_LOCALE_CODES.every(
        (k) =>
          typeof m.title[k as keyof typeof m.title] === "string" &&
          m.title[k as keyof typeof m.title].length > 0 &&
          m.description[k as keyof typeof m.description],
      ) ||
      m.layout.minW < 1 ||
      m.layout.minW > m.layout.w ||
      m.layout.w > 12 ||
      m.layout.minH < 4 ||
      m.layout.h < m.layout.minH ||
      m.layout.h > 24 ||
      m.minRefreshSeconds < 60 ||
      m.services.some((k) => !module.services[k]) ||
      m.actions.some((k) => !module.actions?.[k])
    )
      throw new GadgetError("invalidInput");
    if (
      Object.values({ ...module.services, ...module.actions }).some(
        (s) => typeof s.authorize !== "function" || typeof s.handle !== "function",
      )
    )
      throw new GadgetError("invalidInput");
    if (
      !["system", "extension"].includes(m.source) ||
      !Object.values(m.layout).every(Number.isSafeInteger) ||
      m.layout.w < 1 ||
      m.layout.h < 4 ||
      m.services.length > 20 ||
      m.actions.length > 20 ||
      !Number.isFinite(m.minRefreshSeconds) ||
      m.minRefreshSeconds > 86400 ||
      (module.frontend && Buffer.byteLength(module.frontend) > 256 * 1024) ||
      m.services.concat(m.actions).some((n) => !/^[-a-zA-Z0-9._]{1,80}$/.test(n))
    )
      throw new GadgetError("invalidInput");
    if (
      m.id.length > 120 ||
      JSON.stringify(m).length > 32000 ||
      m.configVersion > 10000 ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(m.version) ||
      (m.source === "extension" && m.id.startsWith("system.")) ||
      (m.defaultPlacement &&
        (!Object.values(m.defaultPlacement).every(Number.isSafeInteger) ||
          m.defaultPlacement.x < 0 ||
          m.defaultPlacement.x + m.layout.w > 12 ||
          m.defaultPlacement.y < 0 ||
          m.defaultPlacement.y > 4096 ||
          m.defaultPlacement.order < 0))
    )
      throw new GadgetError("invalidInput");
    if (
      !Array.isArray(m.permissions) ||
      m.permissions.length > 20 ||
      m.permissions.some((p) => typeof p !== "string" || p.length > 120)
    )
      throw new GadgetError("invalidInput");
    if (
      Object.entries(m.config).some(
        ([key, field]) =>
          !/^([a-zA-Z][a-zA-Z0-9_]{0,63})$/.test(key) ||
          (field.label &&
            !REQUIRED_LOCALE_CODES.every(
              (locale) =>
                typeof field.label![locale as keyof typeof field.label] === "string" &&
                field.label![locale as keyof typeof field.label].length > 0,
            )),
      )
    )
      throw new GadgetError("invalidInput");
    validateGadgetConfig({}, m);
    this.modules.set(m.id, module);
    return this;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.modules.values()].reverse().map((m) => Promise.resolve().then(() => m.dispose?.())),
    );
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        "Gadget disposal failed",
      );
  }
  catalog() {
    return [...this.modules.values()].map((m) => ({ ...structuredClone(m.manifest), frontend: !!m.frontend }));
  }
  get(id: string) {
    return this.modules.get(id);
  }
  migrate(layout: GadgetLayout) {
    const result = structuredClone(layout);
    for (const item of result.items) {
      const m = this.get(item.gadget);
      if (!m) continue;
      try {
        let next = structuredClone(item.config),
          version = item.configVersion;
        while (version < m.manifest.configVersion) {
          const migration = m.migrations?.[version];
          if (!migration) throw Error();
          next = migration(next);
          version++;
        }
        if (version === m.manifest.configVersion) {
          item.config = validateGadgetConfig(next, m.manifest);
          item.configVersion = version;
        }
      } catch {
        /* Keep the original configuration so one incompatible extension cannot reset the layout. */
      }
    }
    return result;
  }
  async invoke(
    kind: "services" | "actions",
    id: string,
    name: string,
    context: Omit<GadgetServiceContext, "config">,
    config: unknown,
    input: unknown,
  ) {
    if (this.closed) throw new GadgetError("unavailable", 503);
    const module = this.get(id),
      service = module?.[kind]?.[name];
    if (!module || !service || !module.manifest[kind === "services" ? "services" : "actions"].includes(name))
      throw new GadgetError("missing", 404);
    const ctx = { ...context, config: validateGadgetConfig(config, module.manifest) };
    if (ctx.signal.aborted) throw new GadgetError("unavailable", 503);
    if ((this.active.get(ctx.owner) ?? 0) >= 4 || this.total >= 32) throw new GadgetError("unavailable", 503);
    this.active.set(ctx.owner, (this.active.get(ctx.owner) ?? 0) + 1);
    this.total++;
    // Keep the reservation until the provider settles, even if it ignores cancellation.
    const work = Promise.resolve().then(async () => {
      if (!(await service.authorize(ctx))) throw new GadgetError("forbidden", 403);
      if (ctx.signal.aborted) throw new GadgetError("unavailable", 503);
      return service.handle(ctx, input);
    });
    const release = () => {
      this.total--;
      const count = (this.active.get(ctx.owner) ?? 1) - 1;
      if (count) this.active.set(ctx.owner, count);
      else this.active.delete(ctx.owner);
    };
    void work.then(release, release);
    let cancel = () => {};
    let result: unknown;
    try {
      result = await Promise.race([
        work,
        new Promise((_, reject) => {
          cancel = () => reject(new GadgetError("unavailable", 503));
          ctx.signal.addEventListener("abort", cancel, { once: true });
          if (ctx.signal.aborted) cancel();
        }),
      ]);
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
    }
    const json = JSON.stringify(result) ?? "null";
    if (ctx.signal.aborted || Buffer.byteLength(json) > GADGET_LIMITS.responseBytes)
      throw new GadgetError("unavailable", 503);
    return JSON.parse(json) as unknown;
  }
}
