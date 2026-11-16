import { reportDiagnostic } from "../../shared/diagnostics.js";
import { GadgetApiError, type GadgetClient } from "../../gadget/sdk/client.js";
import { ClientGadgetRegistry, type GadgetHandle, type GadgetContext } from "./contracts.js";
import type { GadgetDataBudget } from "./data.js";
import type { GadgetEvents } from "./events.js";
import { sandboxGadget } from "./sandbox.js";
import type { GadgetInstance, GadgetManifest } from "../../shared/gadget/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { gt, type GadgetMessage } from "./messages.js";

export interface GadgetFrame {
  element: HTMLElement;
  body: HTMLElement;
}
interface GadgetMountHost {
  t: Translate;
  locale(): string;
  registry: ClientGadgetRegistry;
  api: Pick<GadgetClient, "frontend" | "invoke">;
  budget: Pick<GadgetDataBudget, "read">;
  events: Pick<GadgetEvents, "publish" | "subscribe">;
  capabilities: ReadonlyMap<string, unknown>;
  navigate(path: string): void;
  notice(text: string): void;
  code(error: unknown): GadgetMessage;
  failure(id: string, frame: GadgetFrame, message: GadgetMessage, retry: boolean): void;
}
interface Mounted {
  element: HTMLElement;
  body: HTMLElement;
  handle?: GadgetHandle;
  controller: AbortController;
  signature: string;
  epoch: number;
  failed?: GadgetMessage;
}
/** Owns mounted handles, cancellation epochs and scoped capabilities independently of layout rendering. */
export class GadgetMounts {
  private readonly mounted = new Map<string, Mounted>();
  constructor(private readonly host: GadgetMountHost) {}
  ensure(id: string): GadgetFrame {
    let mounted = this.mounted.get(id);
    if (!mounted) {
      const element = document.createElement("section"),
        body = document.createElement("div"),
        heading = document.createElement("header");
      element.className = "gadget-instance";
      element.dataset.gadgetInstance = id;
      body.className = "gadget-body";
      heading.className = "gadget-instance-heading";
      element.append(heading, body);
      mounted = { element, body, controller: new AbortController(), signature: "", epoch: 0 };
      this.mounted.set(id, mounted);
      body.addEventListener("gadget-failed", () => this.fail(id, "unavailable"));
    }
    return mounted;
  }
  remove(id: string) {
    const mounted = this.mounted.get(id);
    if (!mounted) return;
    this.dispose(mounted);
    mounted.element.remove();
    this.mounted.delete(id);
  }
  retain(ids: ReadonlySet<string>) {
    for (const id of this.mounted.keys()) if (!ids.has(id)) this.remove(id);
  }
  clear() {
    for (const id of this.mounted.keys()) this.remove(id);
  }
  fail(id: string, code: GadgetMessage, retry = true) {
    const item = this.mounted.get(id);
    if (!item) return;
    this.dispose(item);
    item.failed = code;
    this.host.failure(id, item, code, retry);
  }
  update(instance: GadgetInstance, manifest: GadgetManifest & { frontend?: boolean }) {
    const mounted = this.mounted.get(instance.id);
    if (!mounted) return;
    const body = mounted.body;
    const signature = JSON.stringify([instance.gadget, instance.config, instance.configVersion]);
    if (signature !== mounted.signature) {
      this.dispose(mounted);
      mounted.controller = new AbortController();
      mounted.signature = signature;
      mounted.failed = undefined;
    }
    if (mounted.failed) {
      this.fail(instance.id, mounted.failed);
      return;
    }
    const context = this.context(instance, manifest, mounted),
      ticket = ++mounted.epoch;
    const update = async () => {
      if (!mounted!.handle) {
        let component = this.host.registry.get(instance.gadget);
        if (!component && manifest.frontend) {
          const source = await this.host.api.frontend(manifest.id, mounted!.controller.signal);
          component = sandboxGadget(source);
        }
        if (!component) throw new GadgetApiError("missing", 404);
        if (mounted!.controller.signal.aborted || ticket !== mounted!.epoch) return;
        body.replaceChildren();
        mounted!.handle = component.mount(body, context);
      }
      await mounted!.handle?.update(context);
    };
    void update().catch((error) => {
      if (ticket === mounted!.epoch && !mounted!.controller.signal.aborted)
        this.fail(instance.id, this.host.code(error));
    });
  }
  private context(instance: GadgetInstance, manifest: GadgetManifest, mounted: Mounted): GadgetContext {
    const context: GadgetContext = {
      instance,
      manifest,
      t: this.host.t,
      locale: this.host.locale(),
      signal: mounted.controller.signal,
      capability: <T>(name: string) => {
        if (!manifest.clientCapabilities?.includes(name) || !this.host.capabilities.has(name))
          throw new GadgetApiError("forbidden", 403);
        return this.host.capabilities.get(name) as T;
      },
      events: {
        publish: (name, value) =>
          manifest.events?.publish.includes(name) ? this.host.events.publish(name, value) : false,
        subscribe: (name, read) => {
          if (manifest.events?.subscribe.includes(name))
            this.host.events.subscribe(name, mounted.controller.signal, read);
        },
      },
      data: (name, input = null) => {
        const projection = this.host.registry.service(manifest.id, name);
        if (projection) return Promise.resolve(projection(context, input));
        const key = manifest.id + ":" + JSON.stringify([instance.config, name, input]);
        return this.host.budget.read(key, manifest.minRefreshSeconds, mounted.controller.signal, () =>
          this.host.api.invoke(
            manifest.id,
            instance.id,
            instance.config,
            name,
            input,
            AbortSignal.any([mounted.controller.signal, AbortSignal.timeout(15000)]),
          ),
        );
      },
      action: async (name, input = null) => {
        try {
          const value = (await this.host.api.invoke(
            manifest.id,
            instance.id,
            instance.config,
            name,
            input,
            mounted.controller.signal,
            true,
          )) as { navigate?: string };
          if (
            typeof value?.navigate === "string" &&
            value.navigate.startsWith("/") &&
            !value.navigate.startsWith("//") &&
            !/[\\\r\n\0]/.test(value.navigate)
          )
            this.host.navigate(value.navigate);
          return value;
        } catch (error) {
          this.host.notice(gt(this.host.t, this.host.code(error)));
          throw error;
        }
      },
    };
    return context;
  }
  private dispose(item: Mounted) {
    item.controller.abort();
    item.epoch++;
    try {
      item.handle?.dispose();
    } catch (error) {
      reportDiagnostic("gadget.dispose", error);
    }
    item.handle = undefined;
  }
}
