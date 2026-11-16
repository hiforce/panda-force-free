import { mountRegisteredGadget } from "../../../client/gadget/embedded.js";
import type { ClientGadgetRegistry } from "../../../client/gadget/contracts.js";
import type { Translate } from "../../../shared/i18n/messages.js";
import type { ComposerCapability } from "../bindings.js";
export type ComposerMount = (
  host: HTMLElement,
  project: string,
  closed: () => void,
) => { update(): void; dispose(): void };
/** Entry points supply scope and lifecycle; all UI and actions come from the registered system composer. */
export function systemComposerMount(
  registry: ClientGadgetRegistry,
  capabilities: ReadonlyMap<string, unknown>,
  t: Translate,
  locale: () => string,
): ComposerMount {
  return (host, project, closed) => {
    const base = capabilities.get("panda.composer") as ComposerCapability;
    const scoped: ComposerCapability = {
      ...base,
      creationProject: () => project,
      creationClosed: closed,
    };
    return mountRegisteredGadget(host, registry, "system.composer", {
      id: "composer:" + project,
      identity: base.identity,
      t,
      locale,
      navigate: base.navigate,
      capabilities: new Map(capabilities).set("panda.composer", scoped),
    });
  };
}
