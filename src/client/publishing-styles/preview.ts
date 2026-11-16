import type { Translate } from "../../shared/i18n/messages.js";
import type { TemplateFixturePreview } from "../../shared/plugins/library.js";
import type { SiteThemeDescriptor } from "../../shared/presentation/themes.js";
import type { SiteThemeProfile } from "../../shared/presentation/theme-profile.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { presentationPreviewFrame } from "../presentation-preview.js";

export function channelSamplePreview(host: HTMLElement, sample: TemplateFixturePreview, t: Translate) {
  if (sample.posts.length) {
    setMessageHtml(
      host,
      sample.posts
        .map(
          (post, index) =>
            `<article class="library-post"><small>${index + 1} / ${sample.posts.length} · ${post.weightedLength} / 280</small><pre>${e(post.text)}</pre></article>`,
        )
        .join(""),
    );
  } else if (sample.html) {
    presentationPreviewFrame(host, sample.html, t("plugins.libraryPreview"));
  } else {
    const text = document.createElement("pre");
    text.textContent = sample.text;
    host.replaceChildren(text);
  }
}

/** Declarative typography illustration, explicitly distinct from an engine-generated website. */
export function siteSamplePreview(host: HTMLElement, theme: SiteThemeDescriptor, t: Translate) {
  const profile = theme.profile;
  if (!profile) {
    host.textContent = t("plugins.stylesCodeTheme");
    return;
  }
  siteProfileSamplePreview(host, profile, t);
}
export function siteProfileSamplePreview(host: HTMLElement, profile: SiteThemeProfile, t: Translate) {
  const accent = /^#[a-f0-9]{6}$/i.test(profile.accent) ? profile.accent : "#4c50c6";
  const font = profile.font === "serif" ? "Georgia,serif" : "Arial,sans-serif";
  const width = Math.max(640, Math.min(1280, profile.width));
  presentationPreviewFrame(
    host,
    `<main style="font-family:${font};color:#27313d;max-width:${width}px;margin:0 auto;padding:24px;line-height:${profile.density === "compact" ? "1.5" : "1.8"}"><small style="color:${accent}">${e(t("plugins.stylesSampleEyebrow"))}</small><h1>${e(t("plugins.stylesSampleTitle"))}</h1><p>${e(t("plugins.stylesSampleIntro"))}</p><h2>${e(t("plugins.stylesSampleHeading"))}</h2><p>${e(t("plugins.stylesSampleBody"))}</p><blockquote style="border-left:3px solid ${accent};padding-left:20px;margin:24px 0;color:${accent}">${e(t("plugins.stylesSampleQuote"))}</blockquote><ul><li>${e(t("plugins.stylesSamplePointOne"))}</li><li>${e(t("plugins.stylesSamplePointTwo"))}</li></ul></main>`,
    t("plugins.libraryPreview"),
  );
}
