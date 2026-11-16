/** Shared folios and content motifs keep decorative cover data small enough for the immediate catalog. */
const motifs = {
  writing:
    '<path class="art-accent" d="M0 0h49v7H0z"/><path class="art-ink" d="M0 32h215v13H0zM0 57h166v13H0z"/><path class="art-stroke" d="M0 112h111m-111 20h177m-177 20h153m-153 20h177"/><path class="art-secondary" d="M230 103h68v78h-68z"/>',
  slides:
    '<path class="art-ink" d="M0 0h153v12H0zM0 26h104v7H0z"/><path class="art-soft" d="M0 70h112v113H0z"/><circle class="art-accent" cx="56" cy="126" r="29"/><path class="art-secondary" d="M144 133h37v50h-37z"/><path class="art-accent" d="M201 102h37v81h-37z"/><path class="art-ink" d="M258 65h37v118h-37z"/>',
  image:
    '<path class="art-soft" d="M0 0h298v200H0z"/><circle class="art-accent" cx="211" cy="67" r="36"/><path class="art-secondary" d="m0 200 97-140 110 140z"/><path class="art-ink" d="m131 200 102-105 65 105z"/>',
  web: '<path class="art-stroke" d="M-20 15h338"/><circle class="art-accent" cx="0" cy="0" r="4"/><path class="art-soft" d="M0 43h130v144H0z"/><path class="art-ink" d="M152 56h146v11H152zM152 81h105v7H152z"/><path class="art-stroke" d="M152 115h146m-146 19h113"/><rect class="art-accent" x="152" y="158" width="88" height="26" rx="4"/>',
  video:
    '<rect class="art-ink" width="298" height="151" rx="4"/><circle class="art-accent" cx="149" cy="76" r="34"/><path class="art-paper" d="m141 58 26 18-26 18z"/><path class="art-stroke" d="M0 183h298"/><path class="art-accent" d="M0 177h118v12H0z"/>',
  research:
    '<path class="art-ink" d="M0 0h171v12H0z"/><path class="art-stroke" d="M0 47h229m-229 21h185m-185 21h229m-229 64h108"/><circle class="art-accent" cx="223" cy="137" r="57"/><circle class="art-paper" cx="223" cy="137" r="41"/><path class="art-ink" d="m259 178 36 36 12-12-36-36z"/><path class="art-stroke" d="M203 126h40m-40 21h29"/>',
};

export type SkillCoverKind = keyof typeof motifs;
export const skillCoverKinds = Object.keys(motifs) as SkillCoverKind[];
export const skillCoverVariants = 3;

const folio =
  '<rect class="art-secondary" x="88" y="72" width="408" height="250" rx="5"/><rect class="art-paper" x="122" y="40" width="408" height="264" rx="5"/>';
const structure =
  '<rect class="art-secondary" x="62" y="78" width="357" height="249" rx="5"/><rect class="art-paper" x="84" y="48" width="357" height="264" rx="5"/><path class="art-accent" d="M105 75h5v211h-5z"/><rect class="art-accent" x="478" y="85" width="84" height="43" rx="4"/><rect class="art-paper" x="478" y="164" width="84" height="43" rx="4"/><rect class="art-secondary" x="478" y="243" width="84" height="43" rx="4"/><path class="art-connection" d="M441 106h18v158h19m-19-79h19m-19-79h19"/>';

/** Three compositions share one content motif per category without additional image requests. */
export function coverIllustration(kind: SkillCoverKind, variant = 0, content = motifs[kind]) {
  const composition =
    variant === 1
      ? `${structure}<g transform="translate(130 85) scale(.9)">${content}</g>`
      : `<g${variant === 2 ? ' transform="rotate(4 320 180)"' : ""}>${folio}<path class="art-accent" d="M122 40h10v264h-10z"/><g transform="translate(165 76)">${content}</g>${variant === 2 ? '<path class="art-accent" d="M471 40h28v53l-14-11-14 11z"/>' : ""}</g>`;
  return `<svg class="skill-artwork" viewBox="0 0 640 360" aria-hidden="true" focusable="false">${composition}</svg>`;
}
