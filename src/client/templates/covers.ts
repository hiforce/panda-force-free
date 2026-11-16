import { coverIllustration, skillCoverKinds, skillCoverVariants, type SkillCoverKind } from "./cover-artwork.js";
import { setMessageHtml } from "../i18n.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import { escapeHtml as e } from "../../shared/html.js";
import { localizedText } from "../../shared/presentation/localized.js";
import { includedTemplatePreview } from "../template-previews/builtins.js";
import { builtinSkillCoverMotif } from "./builtin-cover-artwork.js";

export type CoverPresentation = Pick<ManagedTemplate, "key" | "reference" | "templateType" | "artwork"> & {
  categories: readonly string[];
  compatibility: { outputs: readonly import("../../shared/skills/contracts.js").SkillOutput[] };
};

export function skillCoverKind(item: CoverPresentation): SkillCoverKind {
  const category = item.categories.find((key) => skillCoverKinds.includes(key as SkillCoverKind));
  if (category) return category as SkillCoverKind;
  if (item.templateType === "panda.slides-template") return "slides";
  if (item.templateType === "panda.site-theme") return "web";
  return (item.compatibility.outputs.find((key) => skillCoverKinds.includes(key as SkillCoverKind)) ||
    "writing") as SkillCoverKind;
}
function imageUrl(item: CoverPresentation): string | undefined {
  const builtin = includedTemplatePreview(item.key)?.images.home.path;
  if (builtin) return builtin;
  if (!item.artwork) return;
  const ref = item.reference;
  if (ref.registry === "skills")
    return (
      "/api/skill-packs/cover?" +
      new URLSearchParams({ id: ref.packageId, version: ref.version, digest: ref.digest, exportId: ref.exportId })
    );
  if (ref.registry === "portable")
    return "/api/templates/cover?" + new URLSearchParams({ id: ref.id, version: ref.version, digest: ref.digest });
}

/** Cover variation follows skill identity so publishing a new version does not change its appearance. */
function coverVariant(item: CoverPresentation) {
  const ref = item.reference,
    identity = "id" in ref ? ref.id : ref.packageId + "." + ref.exportId;
  return (
    Array.from(identity).reduce((hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0, 0) %
    skillCoverVariants
  );
}

/** Decorative artwork stays text free; titles and descriptions remain real localized interface text. */
export function managedCover(item: CoverPresentation, detail = false) {
  const kind = skillCoverKind(item),
    url = imageUrl(item),
    variant = coverVariant(item);
  const alt = detail && item.artwork ? localizedText(item.artwork.alt, document.documentElement.lang) : "";
  return `<span class="template-cover" data-type="${e(item.templateType)}" data-cover-kind="${kind}" data-cover-variant="${variant}" data-cover-tone="${variant === 1 ? "ink" : "paper"}">${url ? `<img class="template-cover-image" src="${e(url)}" loading="lazy" decoding="async" width="960" height="600" alt="${e(alt)}">` : coverIllustration(kind, variant, builtinSkillCoverMotif(item.reference))}</span>`;
}
export function coverFailed(event: Event) {
  if (!(event.target instanceof HTMLImageElement) || !event.target.classList.contains("template-cover-image")) return;
  const cover = event.target.closest<HTMLElement>(".template-cover"),
    kind = cover?.dataset.coverKind;
  if (cover && kind && skillCoverKinds.includes(kind as SkillCoverKind))
    setMessageHtml(cover, coverIllustration(kind as SkillCoverKind, Number(cover.dataset.coverVariant) || 0));
}
