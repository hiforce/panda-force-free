import type { Translate } from "../../../shared/i18n/messages.js";
import type { TemplateFixturePreview } from "../../../shared/plugins/library.js";
import { presentationPreviewFrame } from "../../presentation-preview.js";
import { setMessageHtml, messageHtml as m } from "../../i18n.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { libraryButton, fixtureState } from "./views.js";

/** Fixed sample output is rendered in an opaque sandbox with no network, scripts, forms or app cookies. */
export function libraryPreview(host: HTMLElement, value: TemplateFixturePreview, t: Translate) {
  const posts = value.posts
    .map(
      (post, index) =>
        `<article class="library-post"><header><span>${index + 1} / ${value.posts.length}</span><span data-invalid="${!post.valid}">${post.weightedLength} / 280</span></header><pre data-i18n-ignore>${e(post.text)}</pre></article>`,
    )
    .join("");
  setMessageHtml(
    host,
    `<section class="library-preview"><h3>${m("plugins.libraryPreview", undefined, t)}</h3><p>${m(fixtureState[value.state], undefined, t)}</p>${value.actualDigest ? `<code>${e(value.actualDigest)}</code>` : ""}<ul>${value.issues.map((issue) => `<li>${e(issue.code)} · ${e(issue.severity)}</li>`).join("")}</ul>${posts || '<div class="library-preview-frame"></div>'}${value.actualDigest && !["blocked", "requiresBuild"].includes(value.state) ? libraryButton(t, "plugins.libraryAcceptBaseline", "baseline") : ""}</section>`,
  );
  if (value.posts.length || !value.html || value.siteEvidence) return;
  presentationPreviewFrame(host.querySelector(".library-preview-frame")!, value.html, t("plugins.libraryPreview"));
}
