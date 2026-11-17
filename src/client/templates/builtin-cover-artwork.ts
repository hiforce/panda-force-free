import { BUILTIN_SKILL_COVERS } from "../../shared/skills/cover-assets.js";
import type { TemplateNativeReference } from "../../shared/templates/catalog.js";

const heading = '<path class="art-ink" d="M0 0h160v11H0z"/><path class="art-stroke" d="M0 30h206"/>';
const lines = '<path class="art-stroke" d="M0 0h110m-110 17h88m-88 17h106"/>';
const card = (x: number, y: number, width: number, height: number, tone = "soft") =>
  `<rect class="art-${tone}" x="${x}" y="${y}" width="${width}" height="${height}" rx="5"/>`;
const motifs: Record<string, string> = {
  "software-prd": `${heading}${card(0, 57, 185, 132)}<path class="art-accent" d="M14 71h8v8h-8zM14 105h8v8h-8zM14 139h8v8h-8z"/><path class="art-stroke" d="M36 75h126m-126 34h99m-99 34h115"/>${card(212, 83, 74, 92, "secondary")}<path class="art-paper" d="m227 128 12 12 29-33 5 5-34 39-18-18z"/>`,
  "technical-proposal": `${heading}${card(84, 57, 124, 47, "accent")}${card(0, 145, 88, 44)}${card(105, 145, 88, 44, "secondary")}${card(210, 145, 88, 44)}<path class="art-stroke" d="M146 104v19M44 145v-22h211v22m-106-22v22"/><g transform="translate(100 75) scale(.7)">${lines}</g>`,
  "api-contract": `${heading}${card(25, 56, 113, 138)}${card(155, 56, 113, 138, "secondary")}<path class="art-ink" d="m17 79-17 27 17 27 7-5-14-22 14-22zm264 0-7 5 14 22-14 22 7 5 17-27z"/><path class="art-stroke" d="M42 79h66m-66 28h48m74-28h76m-76 28h59"/><path class="art-accent" d="M42 145h66v22H42zM171 145h66v22h-66z"/>`,
  "meeting-notes": `${heading}<path class="art-accent" d="M0 58h7v132H0z"/>${card(25, 58, 165, 131)}<g transform="translate(42 80)">${lines}</g><path class="art-stroke" d="M42 144h116m-116 20h88"/><circle class="art-secondary" cx="248" cy="126" r="47"/><path class="art-ink" d="M244 96h8v30l20 14-5 7-23-17z"/>`,
  "decision-brief": `${heading}${card(0, 59, 138, 123)}${card(158, 59, 138, 123, "secondary")}<path class="art-stroke" d="M18 82h95m-95 24h75m80-24h95m-95 24h75"/><path class="art-accent" d="m177 143 13 13 28-31 7 6-35 39-20-21z"/><path class="art-stroke" d="M18 148h77"/>`,
  "release-notes": `${heading}<path class="art-stroke" d="M20 65v119"/><circle class="art-accent" cx="20" cy="71" r="10"/><circle class="art-secondary" cx="20" cy="122" r="8"/><circle class="art-secondary" cx="20" cy="173" r="8"/><path class="art-ink" d="M47 65h157v10H47z"/><path class="art-stroke" d="M47 88h233m-233 34h179m-179 21h210m-210 29h144"/>`,
  "longform-editor": `${heading}<g transform="translate(0 61)">${lines}</g><g transform="translate(161 61)">${lines}</g><path class="art-stroke" d="M0 124h126m-126 20h112m-112 20h109"/><path class="art-accent" d="m168 157 83-83 20 20-83 83-29 9z"/><path class="art-ink" d="m252 74 10-10 20 20-11 10z"/>`,
  "research-digest": `${heading}${card(0, 64, 133, 123, "secondary")}${card(17, 51, 133, 123)}<path class="art-stroke" d="M32 74h101m-101 22h83m-83 22h91"/><circle class="art-accent" cx="225" cy="116" r="46"/><circle class="art-paper" cx="225" cy="116" r="32"/><path class="art-ink" d="m254 149 31 31 9-9-31-31z"/><path class="art-stroke" d="M207 107h36m-36 17h24"/>`,
  "concept-explainer": `${heading}<circle class="art-soft" cx="91" cy="118" r="62"/><circle class="art-secondary" cx="190" cy="118" r="62"/><circle class="art-accent" cx="141" cy="117" r="23"/><path class="art-stroke" d="M26 195h80m69 0h80"/>`,
  "evidence-comparison": `${heading}${card(0, 57, 90, 137)}${card(104, 57, 90, 137, "secondary")}${card(208, 57, 90, 137)}<path class="art-accent" d="M14 73h61v8H14zM118 73h61v8h-61zM222 73h61v8h-61z"/><path class="art-stroke" d="M14 109h54m-54 28h45m59-28h54m-54 28h54m50-28h54m-54 28h37"/>`,
  "executive-deck": `${heading}${card(0, 57, 298, 129)}${card(15, 72, 102, 98, "secondary")}<path class="art-accent" d="M136 132h29v38h-29zM180 107h29v63h-29z"/><path class="art-ink" d="M224 85h29v85h-29z"/><path class="art-stroke" d="M19 199h258"/>`,
  "lesson-deck": `${heading}${card(0, 59, 190, 116)}<path class="art-ink" d="M18 78h126v8H18z"/><path class="art-stroke" d="M18 109h149m-149 21h119"/>${card(210, 78, 80, 98, "secondary")}<circle class="art-accent" cx="250" cy="126" r="23"/><path class="art-stroke" d="M28 196h77m28 0h77m28 0h47"/>`,
  "science-illustration": `${heading}<circle class="art-accent" cx="58" cy="91" r="27"/><path class="art-secondary" d="M0 180 57 119l58 61z"/><path class="art-ink" d="m88 180 47-45 48 45z"/><path class="art-soft" d="M192 81c0-28 46-28 46-4 27-10 45 23 22 34h-68c-18-7-16-26 0-30"/><path class="art-stroke" d="M156 80h25m-8-8 8 8-8 8m59 37v30m-8-8 8 8 8-8M165 188h-27m8-8-8 8 8 8"/>`,
  "infographic-brief": `${heading}${card(0, 58, 93, 135)}<circle class="art-accent" cx="47" cy="100" r="26"/><circle class="art-paper" cx="47" cy="100" r="15"/><path class="art-stroke" d="M16 153h60m-60 18h44"/>${card(111, 58, 187, 60, "secondary")}${card(111, 134, 87, 59)}${card(212, 134, 86, 59, "secondary")}<path class="art-stroke" d="M128 78h146m-146 20h113m-113 53h51m51 0h51"/>`,
  "landing-page-brief": `${heading}${card(0, 59, 298, 132)}${card(174, 76, 107, 98, "secondary")}<path class="art-ink" d="M16 82h125v10H16z"/><path class="art-stroke" d="M16 113h128m-128 19h104"/><rect class="art-accent" x="16" y="153" width="81" height="22" rx="4"/><circle class="art-paper" cx="228" cy="125" r="25"/>`,
  "information-architecture": `${heading}${card(101, 56, 94, 37, "accent")}${card(3, 135, 82, 40)}${card(108, 135, 82, 40, "secondary")}${card(213, 135, 82, 40)}<path class="art-stroke" d="M148 93v20M44 135v-22h211v22m-106-22v22M20 195h48m57 0h48m57 0h48"/>`,
  "short-film-storyboard": `${heading}${card(0, 63, 91, 91, "secondary")}${card(104, 63, 91, 91)}${card(208, 63, 91, 91, "secondary")}<circle class="art-accent" cx="46" cy="98" r="15"/><circle class="art-accent" cx="149" cy="98" r="15"/><path class="art-ink" d="m19 139 27-28 28 28zm102 0 28-28 28 28zM238 84l30 20-30 20z"/><path class="art-stroke" d="M0 180h80m24 0h80m24 0h79"/>`,
  "product-demo-script": `${heading}${card(0, 58, 212, 124)}${card(16, 75, 180, 90, "secondary")}<circle class="art-accent" cx="106" cy="118" r="26"/><path class="art-paper" d="m99 103 22 15-22 15z"/><path class="art-stroke" d="M236 77h60m-60 27h48m-48 27h60m-60 27h42M25 199h164"/>`,
};

/** Built-in identity selects authored artwork; uploaded or custom covers retain precedence. */
export function builtinSkillCoverMotif(reference: TemplateNativeReference) {
  return reference.registry === "skills" && reference.packageId === "panda-force.essentials"
    ? motifs[reference.exportId]
    : undefined;
}

/** Application artwork does not mutate immutable installed bundles or override publisher covers. */
export function builtinSkillCoverImage(reference: TemplateNativeReference) {
  return reference.registry === "skills" && reference.packageId === "panda-force.essentials"
    ? BUILTIN_SKILL_COVERS[reference.exportId]
    : undefined;
}
