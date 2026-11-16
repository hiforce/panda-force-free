import { skillDisplayDefinition, skillDisplayPackName } from "../../shared/presentation/skill-display.js";
import { CreationSkillBrowser } from "./skill-browser.js";
import { openCreationSkillDetails } from "./skill-details.js";
import { internalExecutionSkill } from "../../shared/skills/presentation.js";
import { availableInstalledSkill } from "../../shared/skills/availability.js";
import { coverFailed } from "../templates/covers.js";
import {
  creationSkillKey as key,
  skillText,
  selectedCreationSkill,
  composerCreationSkill,
  type CreationSkillEntry,
} from "./skill-views.js";
import type { CreationSkillSelection } from "../../shared/creation/contracts.js";
import type { InstalledSkillPack } from "../../shared/skills/registry.js";
import type { SkillCapability, SkillDefinition } from "../../shared/skills/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { creationApi } from "./api.js";

export class CreationSkills {
  private entries: CreationSkillEntry[] = [];
  private readonly browser: CreationSkillBrowser;
  private closeDetails: (() => void) | null = null;
  private failed = false;
  private loadingSelected = true;
  private selected: CreationSkillSelection[];
  private cursor: string | null = null;
  private loading = false;
  private live = true;
  private locked = false;
  constructor(
    private readonly host: HTMLElement,
    private readonly t: Translate,
    initial: readonly CreationSkillSelection[],
    private readonly capabilities: readonly SkillCapability[],
    private readonly changed: () => void,
    private readonly error: (value: unknown) => void,
    private readonly presentation: "form" | "composer" = "form",
  ) {
    this.selected = structuredClone([...initial]);
    host.addEventListener("error", coverFailed, true);
    this.browser = new CreationSkillBrowser(
      t,
      (button) => this.action(button),
      () => this.hideDetails(),
    );
    host.onclick = (event) => {
      const target = event.target as Element;
      if (target.closest("[data-skill-browser-open]") && !this.locked) {
        this.browser.show(target.closest<HTMLElement>("[data-skill-browser-open]")!);
        return;
      }
      const button = target.closest<HTMLButtonElement>("[data-skill-action]");
      if (button && !button.disabled) this.action(button);
    };
    const changedParameters = () => {
      this.readParameters();
      this.changed();
    };
    host.oninput = changedParameters;
    host.onchange = changedParameters;
    this.render();
    void this.initialize();
  }
  private hideDetails() {
    this.closeDetails?.();
    this.closeDetails = null;
  }
  private action(button: HTMLButtonElement) {
    if (this.locked || !this.live) return;
    const index = Number(button.dataset.index),
      action = button.dataset.skillAction;
    if (action === "details") {
      const entry = this.entries.find((value) => key(value.reference) === button.dataset.skillKey);
      if (entry) {
        this.closeDetails?.();
        this.closeDetails = openCreationSkillDetails(this.t, entry, button);
      }
      return;
    }
    if (action === "more") {
      void this.load();
      return;
    }
    if (action === "add") {
      const entry = this.entries[index];
      if (!entry?.enabled || !entry.visible) return;
      const existing = this.selected.findIndex((value) => key(value) === key(entry.reference));
      if (existing >= 0) this.selected.splice(existing, 1);
      else {
        if (this.selected.length >= 64) return;
        this.selected = this.selected.filter(
          (value) =>
            key(value) !== key(entry.reference) &&
            (entry.definition.role !== "workflow" || this.definition(value)?.role !== "workflow"),
        );
        this.selected.push(structuredClone(entry.reference));
      }
    } else if (Number.isSafeInteger(index) && this.selected[index]) {
      if (action === "remove") this.selected.splice(index, 1);
      else {
        const next = index + (action === "up" ? -1 : 1);
        if (next >= 0 && next < this.selected.length)
          [this.selected[next], this.selected[index]] = [this.selected[index]!, this.selected[next]!];
      }
    }
    this.render();
    this.changed();
    const next = Math.max(
      0,
      Math.min(this.selected.length - 1, index + (action === "up" ? -1 : action === "down" ? 1 : 0)),
    );
    const focus =
      action === "add"
        ? this.host.querySelector<HTMLElement>(
            `[data-selected-skill] [data-skill-action="remove"][data-index="${this.selected.length - 1}"]`,
          )
        : this.host.querySelector<HTMLElement>(
            `[data-selected-skill] [data-skill-action="remove"][data-index="${next}"]`,
          );
    if (!this.browser.open)
      (
        focus ||
        this.host.querySelector<HTMLElement>("[data-skill-browser-open]") ||
        (this.presentation === "composer"
          ? this.host.closest("form")?.querySelector<HTMLElement>("[data-creative-skill]")
          : null)
      )?.focus({
        preventScroll: true,
      });
  }
  private definition(value: CreationSkillSelection) {
    return this.entries.find((entry) => key(entry.reference) === key(value))?.definition;
  }
  private label(text: Readonly<Record<string, string>>, fallback = "") {
    return skillText(text) || fallback;
  }
  private async initialize() {
    // Catalog discovery must not wait for recovered selections to resolve.
    const catalog = this.load();
    try {
      const distinct = new Map(this.selected.map((value) => [JSON.stringify([value.packageId, value.version]), value]));
      const packs = await Promise.allSettled(
        [...distinct.values()].map((value) => creationApi.skill(value.packageId, value.version)),
      );
      if (!this.live) return;
      for (const result of packs) {
        if (result.status === "fulfilled") this.collect(result.value.package);
        else this.error(result.reason);
      }
      this.render();
    } catch (reason) {
      if (this.live) this.error(reason);
    }
    this.loadingSelected = false;
    if (this.live) this.render();
    await catalog;
  }
  private async load() {
    if (this.loading || !this.live) return;
    this.loading = true;
    this.failed = false;
    this.render();
    try {
      const page = await creationApi.skills(this.cursor || undefined);
      if (!this.live) return;
      for (const pack of page.packages) this.collect(pack);
      this.cursor = page.nextCursor;
    } catch {
      if (this.live) this.failed = true;
    } finally {
      this.loading = false;
      if (this.live) this.render();
    }
  }
  private collect(pack: InstalledSkillPack) {
    for (const original of pack.manifest.skills) {
      const definition = skillDisplayDefinition(pack, original);
      if (!definition.outputTypes.includes("document") || !definition.composition.appliesTo.includes("document"))
        continue;
      const reference = {
        packageId: pack.id,
        version: pack.version,
        digest: pack.digest,
        id: definition.id,
        parameters: {},
      };
      if (this.entries.some((entry) => key(entry.reference) === key(reference))) continue;
      this.entries.push({
        reference,
        definition,
        name: skillDisplayPackName(pack),
        origin: pack.origin,
        publisher: pack.manifest.publisher.name,
        license: pack.manifest.license.expression,
        visible: !internalExecutionSkill(pack, definition),
        enabled:
          availableInstalledSkill(pack, definition) &&
          definition.capabilities.every((value) => this.capabilities.includes(value)),
      });
    }
  }
  private readParameters() {
    for (const node of this.host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-skill-parameter]")) {
      const index = Number(node.dataset.skillIndex),
        id = node.dataset.skillParameter!,
        selected = this.selected[index],
        parameter = selected && this.definition(selected)?.parameters.find((value) => value.id === id);
      if (!selected || !parameter) continue;
      const values = { ...selected.parameters };
      if (parameter.type === "boolean") values[id] = (node as HTMLInputElement).checked;
      else if (!node.value) delete values[id];
      else values[id] = parameter.type === "number" ? Number(node.value) : node.value;
      this.selected[index] = { ...selected, parameters: values };
    }
  }
  private parameters(definition: SkillDefinition | undefined, selected: CreationSkillSelection, index: number) {
    return (definition?.parameters ?? [])
      .map((parameter) => {
        const attributes = `data-skill-index="${index}" data-skill-parameter="${e(parameter.id)}"`,
          value = selected.parameters[parameter.id],
          label = e(this.label(parameter.label));
        if (parameter.type === "boolean")
          return `<label class="wb-choice"><input type="checkbox" ${attributes} ${value === true ? "checked" : ""}>${label}</label>`;
        const required = parameter.required ? "required" : "",
          control =
            parameter.type === "choice"
              ? `<select ${attributes} ${required}><option value=""></option>${parameter.options.map((option) => `<option value="${e(option.value)}" ${value === option.value ? "selected" : ""}>${e(this.label(option.label))}</option>`).join("")}</select>`
              : `<input ${attributes} type="${parameter.type === "number" ? "number" : "text"}" value="${e(value === undefined ? "" : String(value))}" ${required} ${parameter.type === "text" ? `maxlength="${parameter.maxLength ?? 8000}"` : `step="any" ${parameter.minimum === undefined ? "" : `min="${parameter.minimum}"`} ${parameter.maximum === undefined ? "" : `max="${parameter.maximum}"`}`}>`;
        return `<label class="wb-field"><span>${label}</span>${control}</label>`;
      })
      .join("");
  }
  private render() {
    const expanded = [...this.host.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (node) => node.dataset.skillKey ?? "library",
    );
    const focused = this.host.contains(document.activeElement) ? (document.activeElement as HTMLInputElement) : null;
    const focusKey = focused?.dataset.skillParameter
      ? [focused.dataset.skillIndex, focused.dataset.skillParameter]
      : null;
    const selection =
      focused?.tagName === "INPUT" && focused.type === "text" ? [focused.selectionStart, focused.selectionEnd] : null;
    const t = this.t;
    setMessageHtml(
      this.host,
      this.presentation === "composer"
        ? this.selected
            .map((selection, index) =>
              composerCreationSkill(
                t,
                selection,
                index,
                this.entries.find((value) => key(value.reference) === key(selection)),
                this.loadingSelected,
              ),
            )
            .join("")
        : `<div class="creation-skill-list">${
            this.selected.length
              ? this.selected
                  .map((selection, index) => {
                    const entry = this.entries.find((value) => key(value.reference) === key(selection));
                    return selectedCreationSkill(
                      t,
                      selection,
                      index,
                      this.selected.length,
                      entry,
                      this.parameters(entry?.definition, selection, index),
                      this.loadingSelected,
                    );
                  })
                  .join("")
              : `<p class="creation-skill-empty">${codexIcon("sparkles")}<span>${e(t("creation.noSelectedSkills"))}</span></p>`
          }</div><button type="button" class="wb-button creation-skill-add" data-skill-browser-open>${codexIcon("plus")}<span>${e(t("creation.addSkill"))}</span>${codexIcon("arrowUpRight")}</button>`,
    );
    for (const node of this.host.querySelectorAll<HTMLDetailsElement>("details"))
      node.open = expanded.includes(node.dataset.skillKey ?? "library");
    if (focusKey && !this.locked) {
      const next = [...this.host.querySelectorAll<HTMLInputElement>("[data-skill-parameter]")].find(
        (node) => node.dataset.skillIndex === focusKey[0] && node.dataset.skillParameter === focusKey[1],
      );
      next?.focus({ preventScroll: true });
      if (next?.tagName === "INPUT" && next.type === "text" && selection)
        next.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
    }
    this.browser.update({
      entries: this.entries,
      selected: this.selected,
      loading: this.loading,
      failed: this.failed,
      more: Boolean(this.cursor),
    });
    if (this.locked)
      for (const node of this.host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        "input,select,button",
      ))
        node.disabled = true;
  }
  setSelected(value: readonly CreationSkillSelection[], fresh = false) {
    if (fresh) this.browser.reset();
    this.selected = structuredClone([...value]);
    this.render();
  }
  browse(trigger: HTMLElement) {
    if (this.live && !this.locked) this.browser.show(trigger);
  }
  setLocked(value: boolean) {
    if (this.locked !== value) {
      this.locked = value;
      if (value) this.browser.close(false);
      this.render();
    }
  }
  read() {
    this.readParameters();
    return structuredClone(this.selected);
  }
  close() {
    this.live = false;
    this.browser.dispose();
    this.hideDetails();
    this.host.removeEventListener("error", coverFailed, true);
    this.host.onclick = null;
    this.host.oninput = null;
    this.host.onchange = null;
  }
}
