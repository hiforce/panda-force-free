import { ClientGadgetRegistry, type GadgetContext } from "./contracts.js";
import { GadgetEvents } from "./events.js";
import { GadgetDataBudget } from "./data.js";
import { GadgetClient, GadgetApiError } from "../../gadget/sdk/client.js";
import { validateGadgetConfig } from "../../shared/gadget/layout.js";
import { gadgetName, type GadgetInstance } from "../../shared/gadget/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { request } from "../http-client.js";
import { setMessageHtml } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";
import { gadgetIcon } from "./icons.js";
const budget = new GadgetDataBudget();
/** A page can host a registered trusted component without owning another implementation or a saved dashboard layout. */
export function mountRegisteredGadget(
  host: HTMLElement,
  registry: ClientGadgetRegistry,
  type: string,
  options: {
    id: string;
    identity: string;
    t: Translate;
    locale(): string;
    navigate(path: string): void;
    capabilities: ReadonlyMap<string, unknown>;
  },
) {
  const manifest = registry.catalog().find((item) => item.id === type),
    component = registry.get(type);
  if (!manifest || !component) throw new GadgetApiError("missing", 404);
  const controller = new AbortController(),
    events = new GadgetEvents(),
    api = new GadgetClient("", request as typeof fetch);
  const instance: GadgetInstance = {
    id: options.id,
    gadget: manifest.id,
    configVersion: manifest.configVersion,
    config: validateGadgetConfig({}, manifest),
    title: "",
    x: 0,
    y: 0,
    w: manifest.layout.w,
    h: manifest.layout.h,
    visible: { desktop: true, mobile: true },
  };
  host.classList.add("gadget-embedded");
  setMessageHtml(
    host,
    `<section class="gadget-instance" data-gadget-type-id="${e(manifest.id)}"><header class="gadget-instance-heading"><span class="gadget-heading-icon">${gadgetIcon(manifest.icon)}</span><h2 data-embedded-title data-i18n-ignore></h2><button type="button" class="icon-button gadget-help">${gadgetIcon("circleHelp")}</button></header><div class="gadget-body"></div></section>`,
  );
  const heading = host.querySelector<HTMLElement>("[data-embedded-title]")!,
    help = host.querySelector<HTMLElement>(".gadget-help")!;
  let context: GadgetContext = {
    instance,
    manifest,
    t: options.t,
    locale: options.locale(),
    signal: controller.signal,
    capability<T>(name: string) {
      if (!manifest.clientCapabilities?.includes(name) || !options.capabilities.has(name))
        throw new GadgetApiError("forbidden", 403);
      return options.capabilities.get(name) as T;
    },
    events: {
      publish: (name, value) => (manifest.events?.publish.includes(name) ? events.publish(name, value) : false),
      subscribe: (name, read) => {
        if (manifest.events?.subscribe.includes(name)) events.subscribe(name, controller.signal, read);
      },
    },
    data(name, input = null) {
      if (!manifest.services.includes(name)) return Promise.reject(new GadgetApiError("forbidden", 403));
      const projection = registry.service(manifest.id, name);
      if (projection) return Promise.resolve(projection(context, input));
      return budget.read(
        options.identity + ":" + manifest.id + ":" + JSON.stringify([instance.config, name, input]),
        manifest.minRefreshSeconds,
        controller.signal,
        () => api.invoke(manifest.id, instance.id, instance.config, name, input, controller.signal),
      );
    },
    async action(name, input = null) {
      if (!manifest.actions.includes(name)) return Promise.reject(new GadgetApiError("forbidden", 403));
      const value = await budget.run(controller.signal, () =>
        api.invoke(manifest.id, instance.id, instance.config, name, input, controller.signal, true),
      );
      const path = value && typeof value === "object" && "navigate" in value ? value.navigate : null;
      if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !/[\\\r\n\0]/.test(path))
        options.navigate(path);
      return value;
    },
  };
  function title() {
    heading.textContent = gadgetName(manifest!.title, context.locale);
    help.title = gadgetName(manifest!.description, context.locale);
    help.setAttribute("aria-label", help.title);
  }
  title();
  const handle = component.mount(host.querySelector<HTMLElement>(".gadget-body")!, context);
  let live = true;
  return {
    update() {
      if (live) {
        context = { ...context, locale: options.locale() };
        title();
        void handle.update(context);
      }
    },
    dispose() {
      if (!live) return;
      live = false;
      controller.abort();
      handle.dispose();
      host.replaceChildren();
    },
  };
}
