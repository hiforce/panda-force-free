import type { Translate } from "../../shared/i18n/messages.js";
import type {
  NativeSlidesInput,
  NativeSlidesSourceReference,
  NativeSlidesDefinition,
  NativeSlidesProposal,
  NativeSlidesReview,
} from "../../shared/slides/registry.js";
import { setMessageHtml, errorText } from "../i18n.js";

import { PluginApiError } from "../plugins/api.js";
import { nativeSlidesApi as api } from "./native-slides-api.js";
import { createNativeSlidesMapping } from "./native-slides-mapping.js";
import { nativeSlidesImportFrame, nativeSlidesApprovalFrame } from "./native-slides-import-views.js";

/** Editing invalidates review, while an accepted command keeps its operation identity for response-loss retry. */
export function createNativeSlidesImport(t: Translate, host: HTMLElement, changed: () => void) {
  let epoch = 0,
    busy = false,
    source: NativeSlidesSourceReference | null = null,
    proposal: NativeSlidesProposal | null = null,
    base: NativeSlidesDefinition | null = null;
  let mapping: ReturnType<typeof createNativeSlidesMapping> | null = null;
  let reviewed: { input: NativeSlidesInput; value: NativeSlidesReview; operationId: string } | null = null;
  const get = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const customizing = () => !proposal?.definition || !!get<HTMLInputElement>("[data-office-customize]")?.checked;
  function notice(value: string, error = false) {
    let node = get("[data-office-notice]");
    if (!node) {
      host.textContent = "";
      node = document.createElement("p");
      node.dataset.officeNotice = "";
      node.setAttribute("role", "status");
      host.append(node);
    }
    if (node) {
      node.textContent = value;
      node.dataset.error = String(error);
    }
  }
  function invalidate() {
    reviewed = null;
    get("[data-office-approval]")?.replaceChildren();
    notice("");
  }
  function controls() {
    host.setAttribute("aria-busy", String(busy));
    const fields = get<HTMLFieldSetElement>("[data-office-definition]");
    if (fields) {
      fields.disabled = busy || !customizing();
      fields.hidden = !customizing();
    }
    for (const node of host.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "[data-office-customize], [data-office-review], [data-office-accept] input, [data-office-accept] button",
    ))
      node.disabled = busy;
  }
  async function run(work: (generation: number) => Promise<void>) {
    if (busy) return;
    const generation = epoch;
    busy = true;
    controls();
    notice(t("plugins.working"));
    try {
      await work(generation);
    } catch (error) {
      if (generation === epoch)
        notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        );
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  function ensureMapping() {
    if (!mapping && source && proposal && base)
      mapping = createNativeSlidesMapping(
        t,
        get("[data-office-mapping]"),
        source,
        proposal.original,
        base.mapping,
        invalidate,
      );
  }
  function capture(): NativeSlidesInput {
    if (!source || !proposal || !base) throw new PluginApiError(400, { messageId: "templates.officeInvalidPackage" });
    if (!customizing()) return { source, definition: null };
    ensureMapping();
    const value = (field: string) =>
      get<HTMLInputElement | HTMLTextAreaElement>(`[data-office-field="${field}"]`).value;
    try {
      return {
        source,
        definition: {
          settings: {
            ...base.settings,
            id: value("id").trim(),
            version: value("version").trim(),
            name: { ...base.settings.name, en: value("name").trim() },
            description: { ...base.settings.description, en: value("description").trim() },
            publisher: value("publisher").trim(),
            license: value("license").trim(),
          },
          mapping: mapping!.snapshot(),
          licenseText: value("licenseText"),
          readmeText: value("readmeText"),
        },
      };
    } catch {
      throw new PluginApiError(400, { messageId: "templates.officeInvalidMapping" });
    }
  }
  host.oninput = (event) => {
    if (
      !busy &&
      event.target instanceof Element &&
      event.target.matches("[data-office-field], [data-office-map], [data-office-slot]")
    )
      invalidate();
  };
  host.onchange = (event) => {
    if (!busy && event.target instanceof Element && event.target.matches("[data-office-customize]")) {
      invalidate();
      controls();
      if (customizing()) ensureMapping();
    }
  };
  host.onsubmit = (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target.matches("[data-office-settings]"))
      void run(async (generation) => {
        const input = capture(),
          value = await api.review(input);
        if (generation !== epoch) return;
        reviewed = { input, value, operationId: crypto.randomUUID() };
        setMessageHtml(get("[data-office-approval]"), nativeSlidesApprovalFrame(t, value));
        notice(t("plugins.readyForReview"));
      });
    else if (
      event.target.matches("[data-office-accept]") &&
      reviewed &&
      get<HTMLInputElement>("[data-office-license]").checked
    ) {
      const accepted = reviewed;
      void run(async (generation) => {
        await api.install(accepted.input, accepted.value, accepted.operationId);
        changed();
        if (generation === epoch) {
          reviewed = null;
          get("[data-office-approval]").replaceChildren();
          notice(t("plugins.installed"));
        }
      });
    }
  };
  function reset() {
    epoch++;
    busy = false;
    mapping?.dispose();
    mapping = null;
    source = proposal = base = reviewed = null;
    host.replaceChildren();
    host.hidden = true;
  }
  return {
    reset,
    load(reference: NativeSlidesSourceReference) {
      reset();
      source = Object.freeze({ ...reference, selection: Object.freeze({ ...reference.selection }) });
      host.hidden = false;
      host.textContent = t("plugins.working");
      return run(async (generation) => {
        const value = await api.prepare(source!);
        if (generation !== epoch) return;
        proposal = value;
        base = value.definition || {
          settings: {
            schema: 1,
            id: "powerpoint." + value.original.source.sha256.slice(0, 12),
            version: "1.0.0",
            name: { en: "PowerPoint template" },
            description: { en: "Imported PowerPoint template" },
            publisher: "",
            license: "LicenseRef-Private",
          },
          mapping: { schema: "panda.powerpoint-mapping/v1", sourceSha256: value.original.source.sha256, slots: [] },
          licenseText: "",
          readmeText: "",
        };
        setMessageHtml(host, nativeSlidesImportFrame(t, value, base));
        if (!value.definition) ensureMapping();
        notice("");
      });
    },
  };
}
