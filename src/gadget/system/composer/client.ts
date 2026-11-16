import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import type { ClientGadgetRegistry, GadgetContext } from "../../../client/gadget/contracts.js";
import { setMessageHtml } from "../../../client/i18n.js";
import { gt } from "../../../client/gadget/messages.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { DocumentRuntimeLoader } from "../../../client/documents/runtime-loader.js";
import { isModuleNetworkError } from "../../../client/documents/module-network-error.js";
import { prepareDocumentModule } from "../../../client/documents/module-transfer.js";
const runtime = new DocumentRuntimeLoader({
  prime: (retry) => prepareDocumentModule(retry ? "/gadget-document.bundle.js?retry=1" : "/gadget-document.bundle.js"),
  isTransferFailure: isModuleNetworkError,
  evaluate: (retry) => (retry ? import("/gadget-document.bundle.js?retry=1") : import("/gadget-document.bundle.js")),
});
export function register(registry: ClientGadgetRegistry) {
  registry.register(manifest as GadgetManifest, {
    mount(root, initial) {
      let context = initial,
        live = true,
        generation = 0,
        unavailable = false,
        composer: ReturnType<typeof import("./document.js").createDocumentComposer> | null = null;
      const pendingSkills: unknown[] = [];
      let flushing = false;
      function renderStatus() {
        setMessageHtml(
          root,
          `<p class="gadget-empty" role="status">${e(gt(context.t, unavailable ? "unavailable" : "loading"))}</p>${unavailable ? `<button type="button" class="wb-button" data-gc-retry>${e(gt(context.t, "retry"))}</button>` : ""}`,
        );
        const retry = root.querySelector<HTMLButtonElement>("[data-gc-retry]");
        if (retry) retry.onclick = () => void load();
      }
      async function flush() {
        if (flushing || !composer) return;
        flushing = true;
        try {
          while (pendingSkills.length && live) await composer.select(pendingSkills.shift());
        } finally {
          flushing = false;
        }
      }
      async function load() {
        const ticket = ++generation;
        unavailable = false;
        renderStatus();
        try {
          const loaded = await runtime.load();
          if (!live || ticket !== generation) return;
          composer = loaded.createDocumentComposer(root, context);
          await flush();
        } catch {
          if (!live || ticket !== generation) return;
          unavailable = true;
          renderStatus();
        }
      }
      context.events.subscribe("creation.skill-selected", (value) => {
        if (pendingSkills.length < 64) pendingSkills.push(value);
        void flush();
      });
      void load();
      return {
        update(next: GadgetContext) {
          context = next;
          if (composer) composer.update(next);
          else renderStatus();
        },
        dispose() {
          live = false;
          generation++;
          composer?.dispose();
        },
      };
    },
  });
}
