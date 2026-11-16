import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import type { ClientGadgetRegistry } from "../../../client/gadget/contracts.js";
import { gt } from "../../../client/gadget/messages.js";
import { setMessageHtml } from "../../../client/i18n.js";
import { escapeHtml as e } from "../../../shared/html.js";
export function register(registry: ClientGadgetRegistry) {
  registry.register(manifest as GadgetManifest, {
    mount(root, initial) {
      let context = initial,
        epoch = 0;
      return {
        async update(next) {
          context = next;
          const ticket = ++epoch,
            result = (await next.data("summary")) as { counts?: Record<string, number> };
          if (next.signal.aborted || ticket !== epoch) return;
          const counts = result.counts ?? {};
          setMessageHtml(
            root,
            `<div class="gadget-queue-stats">${[
              ["waiting", counts.created || 0],
              ["running", counts.running || 0],
              ["finished", counts.finished || 0],
            ]
              .map(
                ([label, count]) =>
                  `<div><strong>${Number(count).toLocaleString(next.locale)}</strong><small>${e(gt(next.t, label as "running"))}</small></div>`,
              )
              .join(
                "",
              )}</div><button type="button" class="gadget-queue-open wb-button">${e(gt(next.t, "queueLink"))}</button>`,
          );
          root.querySelector("button")!.onclick = () => void context.action("open").catch(() => {});
        },
        dispose() {
          epoch++;
          root.replaceChildren();
        },
      };
    },
  });
}
