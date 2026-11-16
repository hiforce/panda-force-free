import type { GadgetInstance, GadgetManifest } from "../../shared/gadget/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
export interface GadgetContext {
  instance: GadgetInstance;
  manifest: GadgetManifest;
  locale: string;
  t: Translate;
  signal: AbortSignal;
  data(name: string, input?: unknown): Promise<unknown>;
  action(name: string, input?: unknown): Promise<unknown>;
  /** Available only to compiled, trusted application modules; never serialized to extensions. */
  events: {
    publish(name: string, value: unknown): boolean;
    subscribe(name: string, read: (value: unknown) => void): void;
  };
  capability<T>(name: string): T;
}
export interface GadgetHandle {
  update(context: GadgetContext): void | Promise<void>;
  dispose(): void;
}
export interface GadgetComponent {
  mount(root: HTMLElement, context: GadgetContext): GadgetHandle;
}
export class ClientGadgetRegistry {
  private components = new Map<string, GadgetComponent>();
  private manifests: GadgetManifest[] = [];
  private services = new Map<string, Record<string, (context: GadgetContext, input: unknown) => unknown>>();
  register(
    manifest: GadgetManifest,
    component: GadgetComponent,
    services: Record<string, (context: GadgetContext, input: unknown) => unknown> = {},
  ) {
    if (this.components.has(manifest.id)) throw Error("duplicateGadget");
    if (Object.keys(services).some((name) => !manifest.services.includes(name)))
      throw Error("unregisteredGadgetService");
    this.services.set(manifest.id, services);
    this.components.set(manifest.id, component);
    this.manifests.push(manifest);
    return this;
  }
  service(id: string, name: string) {
    return this.services.get(id)?.[name];
  }
  catalog() {
    return structuredClone(this.manifests);
  }
  get(id: string) {
    return this.components.get(id);
  }
}
