const PANDA_SHAPES = `<circle cx="7.5" cy="8" r="4.5" fill="currentColor"/><circle cx="24.5" cy="8" r="4.5" fill="currentColor"/><path d="M5 17c0-7 4.2-12 11-12s11 5 11 12c0 7-4.2 11-11 11S5 24 5 17Z" fill="var(--panda-eye,var(--app-main,#fff))" stroke="currentColor" stroke-width="1.8"/><ellipse cx="11" cy="16" rx="3.5" ry="4.5" transform="rotate(24 11 16)" fill="currentColor"/><ellipse cx="21" cy="16" rx="3.5" ry="4.5" transform="rotate(-24 21 16)" fill="currentColor"/><circle cx="11.5" cy="15.2" r="1.15" fill="var(--panda-eye,var(--app-main,#fff))"/><circle cx="20.5" cy="15.2" r="1.15" fill="var(--panda-eye,var(--app-main,#fff))"/><path d="m13.5 21 2.5 2 2.5-2Z" fill="currentColor"/><path d="M16 23v1.3m0 0c-1.2 1-2.2 1-3.1.2m3.1-.2c1.2 1 2.2 1 3.1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`;

export const PANDA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>svg{color:#242a30;--panda-eye:#fff}@media(prefers-color-scheme:dark){svg{color:#f1f3f5;--panda-eye:#181818}}</style>${PANDA_SHAPES}</svg>`;
export const PANDA_ICON_DATA_URL = `data:image/svg+xml,${encodeURIComponent(PANDA_ICON_SVG)}`;

export function pandaForceMark(className = "") {
  const classes = className.replace(/[^a-zA-Z0-9 _-]/g, "");
  // Retain the sizing class for existing themes and cached client entry points.
  return `<span class="panda-interface-mark panda-force-mark ${classes}" data-panda-force-mark><svg viewBox="0 0 32 32" aria-hidden="true">${PANDA_SHAPES}</svg></span>`;
}
