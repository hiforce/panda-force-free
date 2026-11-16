import { publicationFormatCapabilities } from "../../shared/publishing/format-capabilities.js";
import { renderVariantPreview } from "./preview.js";
import type { DocumentPublicationScope } from "../documents/publication/port.js";
import type { ChannelTemplateDescriptor } from "../../shared/presentation/templates.js";
import { templateReference } from "../../shared/presentation/templates.js";
import { templateOptions, templateChoices } from "./templates.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { DocumentSourceActionResult } from "../../shared/documents/action-result.js";
import type { VariantDetail, VariantSummary } from "../../shared/publishing/variants.js";
import type { PublicationFormat } from "../../shared/publishing/content.js";
import { setMessageHtml, localizeText, errorText } from "../i18n.js";

import { publishingApiFor, PublishingApiError } from "./api.js";
import { publishingFrame, historyOptions, issueList, proofreadingView } from "./views.js";
import { copyVariant, downloadVariant } from "./transfer.js";

/** This view owns selection and request lifetime; the server owns variants and reviews. */
export function createPublishingWorkspace(
  t: Translate,
  social: { open(spaceId: string, variantId: string, title: string): void; close(): void },
) {
  const dialog = document.createElement("dialog");
  dialog.id = "publishingDialog";
  dialog.className = "publishing-dialog";
  document.body.append(dialog);
  let api = publishingApiFor();
  let record: DocumentRecord | null = null,
    detail: VariantDetail | null = null;
  let templates: ChannelTemplateDescriptor[] = [];
  let versions: VariantSummary[] = [],
    epoch = 0,
    busy = false,
    richtext = false;
  let finish: ((content: DocumentSourceActionResult | null) => void) | null = null,
    previous: Element | null = null;
  const get = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  function close(content: DocumentSourceActionResult | null = null) {
    social.close();
    epoch++;
    dialog.close();
    record = null;
    detail = null;
    busy = false;
    const resolve = finish;
    finish = null;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    resolve?.(content);
  }
  function status(value: string, error = false) {
    const target = get<HTMLElement>("#publicationStatus");
    if (!target) return;
    target.textContent = value;
    target.dataset.error = String(error);
  }
  function controls() {
    for (const input of dialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button,select")) {
      if (input.dataset.pubAction === "close") continue;
      input.disabled = busy;
    }
    const prepare = get<HTMLButtonElement>('[data-pub-action="prepare"]');
    if (prepare)
      prepare.disabled =
        busy ||
        !templates.some(
          (item) =>
            templateReference(item) === get<HTMLSelectElement>("#publicationTemplate").value &&
            item.formats.includes(get<HTMLSelectElement>("#publicationFormat").value as PublicationFormat),
        );
    const review = get<HTMLButtonElement>('[data-pub-action="review"]');
    const publish = get<HTMLButtonElement>('[data-pub-action="publish"]');
    if (publish) {
      publish.hidden = !detail || !publicationFormatCapabilities(detail.variant.format)?.delivery;
      publish.disabled =
        busy || !detail?.review || detail.stale || detail.variant.issues.some((issue) => issue.severity === "blocking");
    }
    if (review) {
      review.disabled =
        busy ||
        !detail ||
        detail.stale ||
        !!detail.review ||
        detail.variant.issues.some((i) => i.severity === "blocking");
      localizeText(review, detail?.review ? "publishing.reviewed" : "publishing.markReviewed", undefined, t);
    }
  }
  function templateSettings(selected?: string) {
    const format = get<HTMLSelectElement>("#publicationFormat").value as PublicationFormat,
      select = get<HTMLSelectElement>("#publicationTemplate");
    const compatible = templates.filter((item) => item.formats.includes(format));
    const reference =
      selected ??
      (compatible.some((item) => templateReference(item) === select.value)
        ? select.value
        : compatible[0]
          ? templateReference(compatible[0])
          : "");
    setMessageHtml(select, templateOptions(t, compatible, reference));
    templateChoices(dialog, t, compatible, reference);
    get<HTMLElement>("#publicationTemplateHint").textContent = t(
      publicationFormatCapabilities(format)?.representation === "text"
        ? "publishing.templateTextOnly"
        : "publishing.templateVersionHint",
    );
    controls();
  }
  function history() {
    setMessageHtml(get("#publicationHistory"), historyOptions(t, versions, detail?.variant.id || ""));
  }
  function collapseSettings(collapsed: boolean) {
    get<HTMLElement>(".publishing-settings").dataset.collapsed = String(collapsed);
    get<HTMLButtonElement>('[data-pub-action="settings"]').setAttribute("aria-expanded", String(!collapsed));
  }
  function show() {
    if (!detail) return;
    const variant = detail.variant;
    get<HTMLElement>("#publicationProofread").hidden = true;
    const preview = get<HTMLElement>("#publicationPreview");
    preview.hidden = false;
    get<HTMLSelectElement>("#publicationFormat").value = variant.format;
    templateSettings(`${variant.templateId}@${variant.templateVersion}`);
    localizeText(
      get("#publicationVersionState"),
      detail.stale ? "publishing.staleNotice" : detail.review ? "publishing.reviewed" : "publishing.draftNotice",
      undefined,
      t,
    );
    get<HTMLElement>("#publicationVersionState").dataset.stale = String(detail.stale);
    setMessageHtml(get("#publicationIssues"), issueList(t, detail));
    renderVariantPreview(preview, detail, t, api.imageUrl);
    get<HTMLElement>("#publicationActions").hidden = false;
    history();
    if (window.matchMedia("(max-width: 700px)").matches) collapseSettings(true);
    controls();
  }
  async function execute(action: string, trigger?: HTMLButtonElement) {
    if (!record) return;
    const current = record,
      ports = api,
      generation = epoch;
    if (action === "prepare") {
      const selectedTemplate = templates.find(
        (item) => templateReference(item) === get<HTMLSelectElement>("#publicationTemplate").value,
      );
      if (!selectedTemplate) throw new PublishingApiError(400, { messageId: "publishing.unknownTemplate" });
      const prepared = await ports.prepare(
        current.id,
        current.revisionId,
        get<HTMLSelectElement>("#publicationFormat").value as PublicationFormat,
        selectedTemplate.id,
        selectedTemplate.version,
      );
      if (generation !== epoch) return;
      detail = prepared;
      versions = [
        {
          id: prepared.variant.id,
          revisionId: prepared.variant.source.revisionId,
          format: prepared.variant.format,
          templateId: prepared.variant.templateId,
          templateVersion: prepared.variant.templateVersion,
          title: prepared.variant.title,
          createdAt: prepared.variant.createdAt,
        },
        ...versions,
      ];
      show();
    } else if (action === "history") {
      const selected = get<HTMLSelectElement>("#publicationHistory").value;
      if (!selected) return;
      const loaded = await ports.detail(selected);
      if (generation !== epoch) return;
      detail = loaded;
      show();
    } else if (action === "proofread") {
      if (richtext) throw new PublishingApiError(400, { messageId: "publishing.unsupportedMode" });
      const { suggestions } = await ports.proofread(current.id, current.revisionId);
      if (generation !== epoch) return;
      get<HTMLElement>("#publicationPreview").hidden = true;
      get<HTMLElement>("#publicationActions").hidden = true;
      get<HTMLElement>("#publicationIssues").replaceChildren();
      get<HTMLElement>("#publicationVersionState").replaceChildren();
      const target = get<HTMLElement>("#publicationProofread");
      target.hidden = false;
      setMessageHtml(target, proofreadingView(t, suggestions));
    } else if (action === "apply-suggestions") {
      const selected = [...dialog.querySelectorAll<HTMLInputElement>("[data-suggestion]:checked")].map(
        (i) => i.dataset.suggestion!,
      );
      const proposal = await ports.apply(current.id, current.revisionId, selected);
      if (generation === epoch)
        close({
          kind: "markdown-draft",
          base: {
            documentId: current.id,
            revisionId: current.revisionId,
            sourceHash: current.contentHash,
            version: current.revision,
          },
          content: proposal.content,
        });
    } else if (detail) {
      if (action === "publish") {
        social.open(current.spaceId, detail.variant.id, detail.variant.title);
      } else if (action === "review") {
        const accepted = [...dialog.querySelectorAll<HTMLInputElement>("[data-issue]:checked")].map(
          (i) => i.dataset.issue!,
        );
        const reviewed = await ports.review(detail.variant.id, detail.digest, accepted);
        if (generation !== epoch) return;
        detail = reviewed;
        show();
      } else if (action.startsWith("export-")) {
        const kind = action.slice(7);
        if (kind === "html" || kind === "text" || kind === "bundle")
          await downloadVariant(ports.exportUrl(detail.variant.id, kind));
        if (generation === epoch) status(t("publishing.exported"));
      } else if (action === "copy" || action === "copy-post") {
        const variant = detail.variant,
          post = action === "copy-post" ? variant.posts[Number(trigger?.dataset.index)] : null;
        await copyVariant(
          post?.text || (variant.posts.length ? variant.posts.map((p) => p.text).join("\n\n") : variant.text),
          post || variant.posts.length || variant.format === "plain" ? undefined : variant.html,
        );
        if (generation === epoch) status(t("publishing.copied"));
      }
    }
  }
  async function run(action: string, trigger?: HTMLButtonElement) {
    if (busy || !record) return;
    const generation = epoch;
    busy = true;
    controls();
    status(t("publishing.working"));
    try {
      await execute(action, trigger);
      if (generation === epoch && get<HTMLElement>("#publicationStatus").textContent === t("publishing.working"))
        status("");
    } catch (error) {
      if (generation === epoch)
        status(
          errorText(error instanceof PublishingApiError ? error.payload : null, t, "publishing.unavailable"),
          true,
        );
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-pub-action]") : null;
    if (!button || button.disabled) return;
    if (button.dataset.pubAction === "settings")
      collapseSettings(get<HTMLElement>(".publishing-settings").dataset.collapsed !== "true");
    else if (button.dataset.pubAction === "close") close();
    else void run(button.dataset.pubAction!, button);
  });
  dialog.addEventListener("change", (event) => {
    if ((event.target as Element)?.id === "publicationHistory") void run("history");
    if (["publicationFormat", "publicationTemplate"].includes((event.target as Element)?.id)) templateSettings();
  });
  return {
    close: () => close(),
    open(
      document: DocumentRecord,
      options: { richtext?: boolean; scope?: DocumentPublicationScope } = {},
    ): Promise<DocumentSourceActionResult | null> {
      close();
      previous = window.document.activeElement;
      record = document;
      richtext = !!options.richtext;
      api = publishingApiFor(options.scope?.storage === "files" ? options.scope.projectId : undefined);
      versions = [];
      templates = [];
      detail = null;
      setMessageHtml(dialog, publishingFrame(t, document.title));
      get<HTMLElement>(".publishing-proofread-link").hidden = richtext;
      dialog.showModal();
      controls();
      const generation = epoch;
      void Promise.all([api.list(document.id), api.templates()])
        .then(([result, catalog]) => {
          if (generation === epoch) {
            templates = catalog.templates;
            templateSettings();
            versions = [
              ...versions,
              ...result.variants.filter((item) => !versions.some((existing) => existing.id === item.id)),
            ];
            history();
          }
        })
        .catch((error) => {
          if (generation === epoch)
            status(
              errorText(error instanceof PublishingApiError ? error.payload : null, t, "publishing.unavailable"),
              true,
            );
        });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
}
