import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { ContentProject } from "./workspace.js";
import { escapeHtml as e } from "../../shared/html.js";
import { projectOverviewHeading } from "./project-view.js";
import { setMessageHtml, messageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { accountsApi } from "../accounts/api.js";
import { AccountEditor } from "../accounts/controller.js";
import { deliveryApi } from "../delivery/api.js";
import { ConnectionEditor } from "../delivery/connection-editor.js";
import type { createLazyTemplateManager } from "../templates/lazy-settings.js";

const channels: {
  id: string;
  label: MessageId | string;
  description: MessageId;
  icon: string;
  types: string[];
  available: boolean;
}[] = [
  {
    id: "x",
    label: "X",
    description: "creative.xHint",
    icon: "messageSquare",
    types: ["Post", "Article"],
    available: true,
  },
  {
    id: "wechat",
    label: "creative.wechat",
    description: "creative.wechatHint",
    icon: "messageSquare",
    types: ["wechat"],
    available: true,
  },
  {
    id: "rednote",
    label: "creative.rednote",
    description: "creative.rednoteHint",
    icon: "image",
    types: [],
    available: false,
  },
  {
    id: "website",
    label: "creative.website",
    description: "creative.websiteHint",
    icon: "globe",
    types: ["Hexo", "Docusaurus"],
    available: true,
  },
];
/** Channel hierarchy composes the existing account, connection and template authorities. It never invents connected objects. */
export function createPublishWorkspace(
  t: Translate,
  projects: () => ContentProject[],
  navigate: (path: string) => void,
  templates: ReturnType<typeof createLazyTemplateManager>,
) {
  const accountEditor = new AccountEditor(t),
    connectionEditor = new ConnectionEditor(t, () => {});
  let host: HTMLElement | null = null,
    mounted = "",
    epoch = 0,
    project = "",
    channel = "",
    format = "x-post";
  const label = (c: (typeof channels)[number]) => (c.id === "x" ? "X" : t(c.label as MessageId));
  function stop() {
    epoch++;
    accountEditor.close();
    connectionEditor.close();
    templates.hide();
  }
  function status(value: string) {
    const node = host?.querySelector<HTMLElement>("[data-publish-status]");
    if (node) node.textContent = value;
  }
  async function objects() {
    if (!host || !project) return;
    const generation = ++epoch,
      target = host;
    status(t("documents.loading"));
    try {
      const list =
        channel === "x"
          ? (await accountsApi.list(project)).accounts
          : channel === "website"
            ? (await deliveryApi.connections(project)).connections
            : [];
      if (generation !== epoch || host !== target) return;
      setMessageHtml(
        host.querySelector("[data-publish-objects]")!,
        list
          .map(
            (item) =>
              `<article class="publish-object"><header><span class="resource-object-icon">${codexIcon(channel === "x" ? "messageSquare" : "globe")}</span><div><h2>${e(item.name)}</h2><p>${e(projects().find((p) => p.id === item.projectId)?.name || "")}</p></div><span class="resource-badge">${e(t("authorizationState" in item && item.authorizationState === "ready" ? "creative.connected" : "creative.notConnected"))}</span></header><dl><dt>${e(t("creative.formats"))}</dt><dd>${channel === "x" ? "Post / Article" : "Hexo / Docusaurus"}</dd></dl><button type="button" class="wb-button" data-publish-object="${e(item.id)}">${e(t("creative.manage"))}</button></article>`,
          )
          .join("") || `<div class="resource-empty">${e(t("creative.noDestinations"))}</div>`,
      );
      status("");
    } catch {
      if (generation === epoch) status(t("creative.partialError"));
    }
  }
  async function manage(id = "") {
    if (!host || !project) return;
    accountEditor.close();
    connectionEditor.close();
    const node = host.querySelector<HTMLElement>("[data-publish-editor]")!;
    node.hidden = false;
    if (channel === "x") await accountEditor.mount(node, project, id);
    if (channel === "website") {
      setMessageHtml(
        node,
        `<label class="resource-field">${e(t("creative.destinations"))}<select class="wb-select" id="connectionPicker"></select></label><p id="connectionNotice" role="status" hidden></p><div id="connectionEditor"></div>`,
      );
      await connectionEditor.mount(node, project, id);
    }
  }
  function showTemplates() {
    if (!host) return;
    templates.hide();
    const node = host.querySelector<HTMLElement>("[data-publish-templates]");
    if (!node) return;
    templates.show(
      node,
      channel === "website"
        ? { domain: "publishing", section: "site", engine: format === "all" ? "" : format }
        : { domain: "publishing", section: "channel", format: channel === "wechat" ? "wechat" : format },
    );
  }
  return {
    show(target: HTMLElement, selection = "", projectSelection = "") {
      const key =
        selection + ":" + projectSelection + ":" + document.documentElement.lang + ":" + JSON.stringify(projects());
      if (host === target && mounted === key) return;
      stop();
      host = target;
      mounted = key;
      channel = selection;
      project = projectSelection || project || projects()[0]?.id || "";
      const selected = channels.find((c) => c.id === channel);
      format = channel === "website" ? "hexo" : "x-post";
      setMessageHtml(
        host,
        `<section class="publish-workspace ${projectSelection ? "project-overview project-publish-view" : ""}">${
          projectSelection
            ? projectOverviewHeading(
                t,
                projectSelection,
                projects().find((p) => p.id === projectSelection),
                "",
                "publish",
              )
            : ""
        }<header class="resource-heading project-section-heading"><div>${selected ? `<a href="/publish${projectSelection ? "?project=" + encodeURIComponent(projectSelection) : ""}" data-wb="route" data-route="/publish${projectSelection ? "?project=" + encodeURIComponent(projectSelection) : ""}" class="resource-back">${messageHtml("creative.backPublish", {}, t)}</a>` : ""}<${projectSelection ? "h2" : "h1"}>${selected ? e(label(selected)) : messageHtml("creative.publish", {}, t)}</${projectSelection ? "h2" : "h1"}><p>${messageHtml(selected?.description || "creative.channelHint", {}, t)}</p></div></header>${
          !selected
            ? `<div class="publish-channel-grid">${channels.map((c) => `<button type="button" class="publish-channel" data-publish-channel="${c.id}" ${c.available ? "" : "disabled"}><span class="resource-object-icon">${codexIcon(c.icon)}</span><h2>${c.id === "x" ? "X" : messageHtml(c.label as MessageId, {}, t)}</h2><p>${messageHtml(c.description, {}, t)}</p><footer>${c.types.map((value) => `<span class="resource-badge">${e(value === "wechat" ? t("creative.articles") : value)}</span>`).join("")}${!c.available ? `<span class="resource-badge">${e(t("creative.unavailable"))}</span>` : ""}</footer></button>`).join("")}</div>`
            : `${
                projectSelection
                  ? ""
                  : `<label class="resource-field publish-project">${e(t("creative.project"))}<select class="wb-select" data-publish-project aria-label="${e(t("creative.chooseProject"))}"><option value="">${e(t("creative.chooseProject"))}</option>${projects()
                      .map(
                        (p) => `<option value="${e(p.id)}" ${p.id === project ? "selected" : ""}>${e(p.name)}</option>`,
                      )
                      .join("")}</select></label>`
              }<div class="resource-heading resource-section-heading"><h2>${e(t("creative.destinations"))}</h2>${["x", "website"].includes(channel) ? `<button type="button" class="wb-button" data-publish-new ${project ? "" : "disabled"}>${e(t("creative.addDestination"))}</button>` : ""}</div><p data-publish-status role="status"></p><div class="publish-objects" data-publish-objects></div><div class="publish-object-editor" data-publish-editor hidden></div><section class="publish-type-section"><h2>${e(t("creative.formats"))}</h2><nav class="resource-type-tabs">${(channel ===
              "x"
                ? [
                    ["x-post", "Post"],
                    ["x-article", "Article"],
                  ]
                : channel === "website"
                  ? [
                      ["hexo", "Hexo"],
                      ["docusaurus", "Docusaurus"],
                      ["all", t("creative.all")],
                    ]
                  : [["wechat", t("creative.wechat")]]
              )
                .map(
                  ([value, title], i) =>
                    `<button type="button" data-publish-format="${value}" aria-pressed="${i === 0}">${e(title!)}</button>`,
                )
                .join(
                  "",
                )}</nav><div data-publish-templates></div></section>${project ? `<a class="wb-button" href="/documents?project=${encodeURIComponent(project)}" data-wb="route" data-route="/documents?project=${encodeURIComponent(project)}">${e(t("creative.openDocuments"))}</a>` : ""}`
        }</section>`,
      );
      host.onclick = (event) => {
        const b = (event.target as Element).closest<HTMLElement>("button");
        if (!b) return;
        if (b.dataset.publishChannel)
          navigate("/publish/" + b.dataset.publishChannel + (project ? "?project=" + encodeURIComponent(project) : ""));
        if (b.dataset.publishObject || b.hasAttribute("data-publish-new"))
          void manage(b.dataset.publishObject).catch(() => status(t("documents.unavailable")));
        if (b.dataset.publishFormat) {
          format = b.dataset.publishFormat;
          host!
            .querySelectorAll<HTMLElement>("[data-publish-format]")
            .forEach((n) => n.setAttribute("aria-pressed", String(n === b)));
          showTemplates();
        }
      };
      host.onchange = (event) => {
        if ((event.target as Element).matches("[data-publish-project]")) {
          project = (event.target as HTMLSelectElement).value;
          navigate("/publish/" + channel + "?project=" + encodeURIComponent(project));
        }
      };
      if (selected) {
        void objects();
        showTemplates();
      }
    },
    hide() {
      if (!host) return;
      if (host) {
        host.onclick = null;
        host.oninput = null;
        host.onchange = null;
      }
      stop();
      host = null;
      mounted = "";
    },
  };
}
