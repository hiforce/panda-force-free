import type { Translate } from "../../shared/i18n/messages.js";
import type { BuildEngine } from "../../shared/builds/engines.js";
import type {
  NativeThemeSourceSelection,
  NativeThemeInput,
  NativeThemeProposal,
  NativeThemeReview,
} from "../../shared/templates/native/contracts.js";
import { nativeThemeSettings } from "../../shared/templates/native/settings.js";
import { setMessageHtml, errorText } from "../i18n.js";

import { PluginApiError } from "../plugins/api.js";
import { nativeThemeApi as api } from "./native-theme-api.js";
import { nativeThemeForm, nativeThemeApproval } from "./native-theme-views.js";

/** The form owns its edits and accepted retry identity; source polling never replaces it. */
export function createNativeThemeImport(t: Translate, host: HTMLElement, changed: () => void) {
  let epoch = 0,
    busy = false,
    source: NativeThemeSourceSelection | null = null,
    proposal: NativeThemeProposal | null = null,
    reviewed: { input: NativeThemeInput; value: NativeThemeReview; operationId: string } | null = null;
  const get = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  function reset() {
    epoch++;
    busy = false;
    source = proposal = reviewed = null;
    host.replaceChildren();
    host.hidden = true;
  }
  function controls() {
    host.setAttribute("aria-busy", String(busy));
    for (const node of host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>(
      "input,button,textarea",
    ))
      node.disabled = busy;
  }
  function notice(text: string, failed = false) {
    let node = host.querySelector<HTMLElement>("[data-native-notice]");
    if (!node) {
      host.textContent = "";
      node = document.createElement("p");
      node.dataset.nativeNotice = "";
      node.setAttribute("role", "status");
      host.append(node);
    }
    if (node) {
      node.textContent = text;
      node.dataset.error = String(failed);
    }
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
        notice(errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.invalidPackage"), true);
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  function capture(): NativeThemeInput {
    const value = (name: string) =>
      get<HTMLInputElement | HTMLTextAreaElement>(`[data-native-field="${name}"]`).value.trim();
    if (!source || !proposal) throw new PluginApiError(400, { messageId: "plugins.invalidPackage" });
    return {
      source: { ...source },
      settings: nativeThemeSettings({
        ...proposal.settings,
        id: value("id"),
        version: value("version"),
        name: { ...proposal.settings.name, en: value("name") },
        description: { ...proposal.settings.description, en: value("description") },
        publisher: value("publisher"),
        license: { expression: value("license"), file: value("licenseFile") },
        readme: value("readme") || null,
        entry: proposal.settings.engine === "hexo" ? null : value("entry"),
        dependencies: JSON.parse(value("dependencies")),
      }),
    };
  }
  host.oninput = (event) => {
    if (event.target instanceof Element && event.target.matches("[data-native-field]") && !busy) {
      reviewed = null;
      get("[data-native-approval]").replaceChildren();
      notice("");
    }
  };
  host.onsubmit = (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target.matches("[data-native-settings]"))
      void run(async (generation) => {
        const input = capture(),
          value = await api.review(input);
        if (generation !== epoch) return;
        reviewed = { input, value, operationId: crypto.randomUUID() };
        setMessageHtml(get("[data-native-approval]"), nativeThemeApproval(t, value));
        notice(t("plugins.readyForReview"));
      });
    else if (event.target.matches("[data-native-accept]") && reviewed) {
      const accepted = reviewed;
      void run(async (generation) => {
        await api.install(accepted.input, accepted.value, accepted.operationId);
        changed();
        if (generation === epoch) {
          reviewed = null;
          get("[data-native-approval]").replaceChildren();
          notice(t("plugins.installed"));
        }
      });
    }
  };
  return {
    reset,
    load(reference: NativeThemeSourceSelection, engine: BuildEngine) {
      reset();
      host.hidden = false;
      source = Object.freeze({ ...reference });
      host.textContent = t("sources.working");
      return run(async (generation) => {
        const value = await api.prepare(reference, engine);
        if (generation !== epoch) return;
        proposal = value;
        setMessageHtml(host, nativeThemeForm(t, value, reference.root));
        notice("");
      });
    },
  };
}
