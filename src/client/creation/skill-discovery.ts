import type { Translate } from "../../shared/i18n/messages.js";
import type { CreationSkillSelection } from "../../shared/creation/contracts.js";
import { DOCUMENT_CREATION_CAPABILITIES } from "../../shared/creation/contracts.js";
import { creationApi } from "./api.js";
import { creationSkillEntries } from "./skill-entries.js";
import { creationDiscoverySkill, creationSkillKey, skillText, type CreationSkillEntry } from "./skill-views.js";
import { CreationSkillCategories } from "./skill-categories.js";
import { openCreationSkillDetails } from "./skill-details.js";
import { coverFailed } from "../templates/covers.js";
import { getBrowserI18n, localizeText, messageHtml, messageAttributes, setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";

/** The entry page discovers real available skills and adds them to the shared composer without starting a task. */
export class CreationSkillDiscovery {
  readonly root = document.createElement("section");
  private readonly entries: CreationSkillEntry[] = [];
  private readonly grid: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly notice: HTMLElement;
  private readonly more: HTMLButtonElement;
  private readonly categories: CreationSkillCategories;
  private visible = false;
  private loading = false;
  private cursor: string | null = null;
  private initialized = false;
  private query = "";
  private signature = "";
  private closeDetails?: () => void;
  constructor(
    private readonly t: Translate,
    private readonly selected: () => readonly CreationSkillSelection[],
    private readonly add: (selection: CreationSkillSelection) => void,
  ) {
    this.root.className = "creation-skill-discovery";
    setMessageHtml(
      this.root,
      `<header class="creation-discovery-heading"><div><h2>${messageHtml("creation.discoverSkills", {}, t)}</h2><p>${messageHtml("creation.discoveryHint", {}, t)}</p></div><a class="session-text-button" href="/skills">${messageHtml("creation.viewAll", {}, t)}${codexIcon("arrowUpRight")}</a></header><div class="creation-discovery-search wb-form"><label class="wb-field"><span class="sr-only">${messageHtml("creation.searchSkills", {}, t)}</span><input type="search" data-discovery-search ${messageAttributes("placeholder", "creation.browserSearchHint", {}, t)} ${messageAttributes("aria-label", "creation.searchSkills", {}, t)}></label></div><div data-discovery-categories></div><div class="creation-discovery-grid" data-discovery-grid></div><p role="status" data-discovery-notice></p><button type="button" class="session-button" data-discovery-more hidden>${messageHtml("creation.moreSkills", {}, t)}</button>`,
    );
    this.grid = this.root.querySelector<HTMLElement>("[data-discovery-grid]")!;
    this.search = this.root.querySelector<HTMLInputElement>("input")!;
    this.notice = this.root.querySelector<HTMLElement>("[data-discovery-notice]")!;
    this.more = this.root.querySelector<HTMLButtonElement>("[data-discovery-more]")!;
    this.categories = new CreationSkillCategories(
      this.root.querySelector<HTMLElement>("[data-discovery-categories]")!,
      t,
      () => this.render(),
      "all",
    );
    this.search.oninput = () => {
      this.query = this.search.value;
      this.render();
    };
    this.more.onclick = () => void this.load();
    this.grid.addEventListener("error", coverFailed, true);
    this.grid.onclick = (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-skill-action]") : null;
      if (!button || button.disabled) return;
      const entry = this.entries.find((entry) => creationSkillKey(entry.reference) === button.dataset.skillKey);
      if (!entry) return;
      if (button.dataset.skillAction === "details") {
        this.closeDetails?.();
        this.closeDetails = openCreationSkillDetails(t, entry, button);
      } else {
        this.add(entry.reference);
        this.render();
      }
    };
    getBrowserI18n().subscribe(() => {
      if (this.visible) {
        this.signature = "";
        this.render();
        this.categories.refresh();
      }
    });
  }
  show(host: HTMLElement) {
    if (this.root.parentElement !== host) host.append(this.root);
    this.visible = true;
    this.categories.refresh();
    this.render();
    if (!this.initialized && !this.loading) void this.load();
  }
  hide() {
    this.visible = false;
    this.closeDetails?.();
    this.closeDetails = undefined;
    this.root.remove();
  }
  update() {
    if (this.visible) this.render();
  }
  private async load() {
    if (this.loading) return;
    this.loading = true;
    this.render();
    try {
      const result = await creationApi.skills(this.cursor || undefined);
      for (const pack of result.packages)
        for (const entry of creationSkillEntries(pack, DOCUMENT_CREATION_CAPABILITIES, true))
          if (
            !this.entries.some((existing) => creationSkillKey(existing.reference) === creationSkillKey(entry.reference))
          )
            this.entries.push(entry);
      this.cursor = result.nextCursor;
      this.initialized = true;
      this.notice.textContent = "";
    } catch {
      localizeText(this.notice, "creation.skillLoadFailed", {}, this.t);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "session-text-button";
      localizeText(retry, "common.retry", {}, this.t);
      retry.onclick = () => void this.load();
      this.notice.append(" ", retry);
    } finally {
      this.loading = false;
      if (this.visible) this.render();
    }
  }
  private render() {
    const signature = JSON.stringify([
      this.entries.map((entry) => entry.reference),
      this.selected(),
      this.query,
      this.loading,
      document.documentElement.lang,
      this.root.querySelector("[data-skill-category][aria-pressed=true]")?.getAttribute("data-skill-category"),
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const matches = this.entries.filter(
      (entry) =>
        entry.visible &&
        this.categories.matches(entry) &&
        (!this.query ||
          [skillText(entry.definition.name), skillText(entry.definition.description), entry.definition.id]
            .join(" ")
            .toLocaleLowerCase()
            .includes(this.query.toLocaleLowerCase())),
    );
    const featured = [
      "software-prd",
      "research-digest",
      "science-illustration",
      "executive-deck",
      "short-film-storyboard",
      "landing-page-brief",
    ];
    matches.sort((a, b) => {
      const rank = (entry: CreationSkillEntry) =>
        entry.reference.packageId === "panda-force.essentials" && featured.includes(entry.reference.id)
          ? featured.indexOf(entry.reference.id)
          : featured.length;
      return rank(a) - rank(b);
    });
    setMessageHtml(
      this.grid,
      matches.map((entry) => creationDiscoverySkill(this.t, entry, this.selected())).join("") ||
        `<p class="creation-skill-picker-hint">${this.t(this.loading ? "creation.loadingSkill" : this.query ? "creation.noSkillMatches" : "creation.noSkills")}</p>`,
    );
    this.more.hidden = !this.cursor;
    this.more.disabled = this.loading;
  }
}
