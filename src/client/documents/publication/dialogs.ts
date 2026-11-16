import type { Translate } from "../../../shared/i18n/messages.js";
import type { DocumentRecord, DocumentSpace } from "../../../shared/documents/contracts.js";
import type { DocumentPlacement } from "../../../shared/documents/placements.js";
import { compatibleDocumentLocale } from "../../../shared/documents/locales.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { messageHtml as m, setMessageHtml, getBrowserI18n, errorText } from "../../i18n.js";
import { DocumentApiError } from "../api.js";
import type { PublicationConfigurationApi } from "./port.js";
import { DocumentModal } from "../modal.js";
import { field } from "../views.js";

export class DocumentPlacementDialogs {
  constructor(
    private t: Translate,
    private modal: DocumentModal,
    private api: PublicationConfigurationApi,
  ) {}
  async edit(document: DocumentRecord, spaces: DocumentSpace[], existing?: DocumentPlacement, preferred?: string) {
    const requestEpoch = this.modal.generation;
    const { revisions } = await this.api.sources.history(document.id);
    if (existing?.revisionId && !revisions.some((revision) => revision.id === existing.revisionId)) {
      revisions.push((await this.api.sources.revision(document.id, existing.revisionId)).revision);
    }
    if (requestEpoch !== this.modal.generation) return null;
    const target =
      existing?.spaceId || preferred || spaces.find((space) => space.locale === document.locale)?.id || spaces[0]?.id;
    if (!target) return null;
    const t = this.t,
      metadata = existing?.metadata || {},
      tagText =
        Array.isArray(metadata.tags) && metadata.tags.every((tag) => typeof tag === "string")
          ? metadata.tags.join(", ")
          : typeof metadata.tags === "string"
            ? metadata.tags
            : "";
    let intent: { signature: string; id: string } | null = null,
      spaceVersion = spaces.find((space) => space.id === target)?.version,
      policyReady = false;
    const pending = this.modal.form(
      t(existing ? "documents.editPublicationLink" : "documents.addPublicationLink"),
      `<p>${m("documents.publicationLinkHint", undefined, t)}</p><label for="doc-link-space">${m("documents.targetSpace", undefined, t)}</label><select id="doc-link-space" ${existing ? "disabled" : 'name="document-spaceId"'}>${spaces.map((space) => `<option value="${e(space.id)}" ${space.id === target ? "selected" : ""}>${e(space.name)} · ${e(space.engine)}</option>`).join("")}</select>` +
        field(
          t,
          "documents.targetPath",
          "path",
          existing?.path || this.defaultPath(document.title),
          'required maxlength="240" pattern=".+\\.md"',
        ) +
        `<label for="doc-link-revision">${m("documents.sourceVersion", undefined, t)}</label><select id="doc-link-revision" name="document-revisionId"><option value="" ${!existing?.revisionId ? "selected" : ""}>${e(t("documents.followLatestRevision", { number: document.revision }))}</option>${revisions.map((revision) => `<option value="${e(revision.id)}" ${revision.id === existing?.revisionId ? "selected" : ""}>${e(t("documents.revision", { number: revision.number }))} · ${e(revision.locale)} · ${e(revision.title)}</option>`).join("")}</select>` +
        field(
          t,
          "documents.locale",
          "locale",
          existing?.locale || document.locale,
          'required maxlength="35" list="placementLanguages" pattern="[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*"',
        ) +
        `<datalist id="placementLanguages"></datalist><p id="placementEditionNotice" role="status"></p><button id="placementReloadEdition" type="button" class="wb-button" hidden>${m("documents.refreshLinks", undefined, t)}</button><p>${m("documents.publicationLanguageHint", undefined, t)}</p><details class="placement-metadata"><summary>${m("documents.targetMetadata", undefined, t)}</summary>` +
        field(
          t,
          "documents.targetTitle",
          "title",
          typeof metadata.title === "string" ? metadata.title : "",
          'maxlength="200"',
        ) +
        `<label for="doc-description">${m("documents.targetDescription", undefined, t)}</label><textarea id="doc-description" name="document-description" rows="3" maxlength="2000">${e(typeof metadata.description === "string" ? metadata.description : "")}</textarea>` +
        field(t, "documents.targetTags", "tags", tagText, 'maxlength="2000"') +
        field(
          t,
          "documents.targetDate",
          "date",
          typeof metadata.date === "string" ? metadata.date : "",
          'maxlength="40"',
        ) +
        `<p>${m("documents.targetMetadataHint", undefined, t)}</p></details>`,
      t("documents.savePublicationLink"),
      async (fields) => {
        if (!policyReady) throw new DocumentApiError(503, { messageId: "documents.publicationEditionRetry" });
        const values = { ...metadata };
        for (const key of ["title", "description", "date"]) {
          if (fields[key]?.trim()) values[key] = fields[key]!.trim();
          else delete values[key];
        }
        if (fields.tags !== tagText || !existing) {
          if (fields.tags?.trim())
            values.tags = fields.tags
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
          else delete values.tags;
        }
        const input = {
          documentId: document.id,
          spaceId: existing?.spaceId || fields.spaceId,
          path: fields.path,
          locale: fields.locale,
          revisionId: fields.revisionId || null,
          metadata: values,
        };
        const signature = JSON.stringify(input);
        if (!intent || intent.signature !== signature) intent = { signature, id: crypto.randomUUID() };
        try {
          return (
            existing
              ? await this.api.placements.update(existing.id, { ...input, version: existing.version, spaceVersion })
              : await this.api.placements.create({ ...input, id: intent.id, spaceVersion })
          ).placement;
        } catch (error) {
          if (error instanceof DocumentApiError && error.status === 409) await refreshEdition(false);
          throw error;
        }
      },
      { canSubmit: () => policyReady },
    );
    const epoch = this.modal.generation,
      host = this.modal.element,
      select = host.querySelector<HTMLSelectElement>("#doc-link-space")!,
      revision = host.querySelector<HTMLSelectElement>("#doc-link-revision")!,
      locale = host.querySelector<HTMLInputElement>("#doc-locale")!;
    let editionRequest = 0;
    const sourceLocale = () => revisions.find((value) => value.id === revision.value)?.locale || document.locale;
    const refreshEdition = async (suggest: boolean) => {
      const generation = ++editionRequest,
        id = select.value,
        submit = host.querySelector<HTMLButtonElement>('[type="submit"]')!,
        notice = host.querySelector<HTMLElement>("#placementEditionNotice")!;
      submit.disabled = true;
      policyReady = false;
      notice.textContent = t("documents.loadingPublicationEdition");
      try {
        const result = await this.api.spaces.sourceProfile(id);
        if (epoch !== this.modal.generation || generation !== editionRequest) return;
        spaceVersion = result.space.version;
        policyReady = true;
        const editions = Object.keys(result.profile?.editions || {}),
          compatible = editions.filter((value) => compatibleDocumentLocale(sourceLocale(), value));
        setMessageHtml(
          host.querySelector("#placementLanguages"),
          editions.map((value) => `<option value="${e(value)}"></option>`).join(""),
        );
        if (
          suggest &&
          (!compatibleDocumentLocale(sourceLocale(), locale.value) ||
            (editions.length && !editions.includes(locale.value)))
        )
          locale.value = compatible[0] || sourceLocale();
        notice.textContent = editions.length
          ? t("documents.availableEditions", { languages: editions.join(", ") })
          : "";
      } catch (error) {
        if (epoch !== this.modal.generation || generation !== editionRequest) return;
        notice.textContent = errorText(
          error instanceof DocumentApiError ? error.payload : null,
          t,
          "documents.publicationEditionRetry",
        );
      } finally {
        if (epoch === this.modal.generation && generation === editionRequest) {
          submit.disabled = !policyReady;
          host.querySelector<HTMLButtonElement>("#placementReloadEdition")!.hidden = policyReady;
        }
      }
    };
    const refresh = () => void refreshEdition(true);
    select.onchange = refresh;
    revision.onchange = refresh;
    host.querySelector<HTMLButtonElement>("#placementReloadEdition")!.onclick = refresh;
    refresh();
    return pending;
  }
  private defaultPath(title: string) {
    const stem =
      title
        .normalize("NFC")
        .replace(/[\\/:*?"<>|#%\p{Cc}]/gu, " ")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/^\.+/, "")
        .slice(0, 60) || "article";
    return stem + ".md";
  }
  remove(placement: DocumentPlacement, spaceVersion: number) {
    return this.modal.form(
      this.t("documents.removePublicationLink"),
      `<p>${m("documents.removePublicationLinkHint", undefined, this.t)}</p><code data-i18n-ignore>${e(placement.path)}</code>`,
      this.t("documents.removePublicationLink"),
      async () => this.api.placements.remove(placement, spaceVersion),
      { tone: "danger" },
    );
  }
  async history(placement: DocumentPlacement) {
    const requestEpoch = this.modal.generation,
      { events } = await this.api.placements.history(placement.id);
    if (requestEpoch !== this.modal.generation) return;
    const t = this.t,
      format = new Intl.DateTimeFormat(getBrowserI18n().locale, { dateStyle: "medium", timeStyle: "short" });
    await this.modal.form(
      t("documents.linkHistory"),
      `<ol class="placement-history">${events.map((event) => `<li><strong>${m(event.operation === "create" ? "documents.linkCreated" : event.operation === "update" ? "documents.linkUpdated" : "documents.linkRemoved", undefined, t)}</strong><time>${e(format.format(event.createdAt))}</time><code data-i18n-ignore>${e(event.placement.path)}</code><span>${e(t("documents.revision", { number: event.placement.version }))}</span></li>`).join("")}</ol>`,
      t("documents.close"),
      async () => true,
    );
  }
}
