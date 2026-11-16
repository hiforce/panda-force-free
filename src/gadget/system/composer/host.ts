import { mountRegisteredGadget } from "../../../client/gadget/embedded.js";
import type { ClientGadgetRegistry } from "../../../client/gadget/contracts.js";
import type { Translate } from "../../../shared/i18n/messages.js";
import type { ComposerCapability } from "../bindings.js";
import { setMessageHtml } from "../../../client/i18n.js";
export type ComposerMount = (
  host: HTMLElement,
  project: string,
  closed: () => void,
  options?: { activity?: boolean },
) => { update(): void; dispose(): void };
/** Entry points supply scope and lifecycle; all UI and actions come from the registered system composer. */
export function systemComposerMount(
  registry: ClientGadgetRegistry,
  capabilities: ReadonlyMap<string, unknown>,
  t: Translate,
  locale: () => string,
): ComposerMount {
  return (host, project, closed, options) => {
    const base = capabilities.get("panda.composer") as ComposerCapability;
    const scoped: ComposerCapability = {
      ...base,
      creationProject: () => project,
      creationClosed: closed,
    };
    const mount = (target: HTMLElement, type: string) =>
      mountRegisteredGadget(target, registry, type, {
        id: type.slice("system.".length) + ":" + project,
        identity: base.identity,
        t,
        locale,
        navigate: base.navigate,
        capabilities: new Map(capabilities).set("panda.composer", scoped),
      });
    if (!options?.activity) return mount(host, "system.composer");
    host.classList.add("creation-entry");
    setMessageHtml(host, "<div data-creation-entry-composer></div><div data-creation-entry-activity></div>");
    const composer = mount(host.querySelector<HTMLElement>("[data-creation-entry-composer]")!, "system.composer"),
      activity = mount(host.querySelector<HTMLElement>("[data-creation-entry-activity]")!, "system.creations");
    return {
      update() {
        composer.update();
        activity.update();
      },
      dispose() {
        composer.dispose();
        activity.dispose();
        host.replaceChildren();
        host.classList.remove("creation-entry");
      },
    };
  };
}
