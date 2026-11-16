import { executionWorkflowSteps } from "../../shared/delivery/recovery.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { PublicationImage } from "../../shared/delivery/media.js";
import type { WorkflowRecord } from "../../shared/delivery/workflow.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";

/** Preview only authorized local assets; never use a platform response as an image URL. */
export function mediaPreview(t: Translate, record: WorkflowRecord, images: PublicationImage[]) {
  if (!images.length) return "";
  const imageUrl = (id: string) =>
    record.plan.sourceProjectId === undefined
      ? "/api/document-assets/content?id=" + id
      : "/api/project-documents/assets/content?" + new URLSearchParams({ project: record.plan.sourceProjectId, id });
  return `<div class="social-media" aria-label="${e(t("social.mediaPreview"))}">${images
    .map((image) => {
      if (!/^[a-f0-9-]{36}$/i.test(image.assetId)) return "";
      const step = executionWorkflowSteps(record)
        .filter(
          (step) =>
            step.key.startsWith(`media.${image.key}.`) &&
            step.operation === "media.upload" &&
            step.outcome === "succeeded",
        )
        .at(-1);
      const observed = [...(record.lineage?.observations || []), ...(record.observations || [])].findLast(
        (item) => item.key === `${step?.key}.status`,
      )?.result;
      const value =
        observed && typeof observed === "object" && !Array.isArray(observed) ? observed.media : step?.result;
      const media = value && typeof value === "object" && !Array.isArray(value) ? value : null;
      const state = media?.state;
      const status =
        state === "succeeded"
          ? "social.mediaReady"
          : state === "failed"
            ? "social.mediaProcessingFailed"
            : "social.mediaPending";
      const expiry =
        typeof media?.expiresAt === "number" && Number.isFinite(media.expiresAt)
          ? new Date(media.expiresAt).toLocaleString()
          : null;
      return `<figure><img loading="lazy" src="${e(imageUrl(image.assetId))}" alt="${e(image.alt)}"><figcaption><strong data-i18n-ignore>${e(image.name)}</strong>${image.alt ? `<span data-i18n-ignore>${e(image.alt)}</span>` : ""}${media ? `<small>${m(status, undefined, t)}</small>` : ""}${expiry ? `<small>${m("social.mediaExpiry", { time: expiry }, t)}</small>` : ""}</figcaption></figure>`;
    })
    .join("")}</div>`;
}
