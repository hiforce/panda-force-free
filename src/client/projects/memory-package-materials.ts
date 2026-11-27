import {
  memoryMaterialAnchorLimit,
  memoryMaterialAnchorSupported,
  memoryMaterialPreview,
  memoryMaterialOriginals,
} from "../../shared/project-memory/materials.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type {
  MemoryMaterialAnchor,
  MemoryMaterialCatalogItem,
  MemoryMaterialExportSelection,
  MemoryMaterialNativeCopy,
  MemoryPackageMaterial,
} from "../../shared/project-memory/materials.js";
import { escapeHtml } from "../../shared/html.js";
import { creativeKindMessages } from "../../shared/creative/file-types.js";
import { harnessApi } from "../harness/api.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import type { memoryCitationEditor } from "./memory-package-citation-editor.js";
import { memoryMaterialUrls, memoryPackageReader } from "./memory-package-reader.js";

export function memoryMaterialPicker(
  path: string,
  section: HTMLDetailsElement,
  signal: AbortSignal,
  t: Translate,
  edit: ReturnType<typeof memoryCitationEditor>,
) {
  const api = harnessApi(t);
  const output = section.querySelector<HTMLElement>("[data-material-options]")!;
  const status = section.querySelector<HTMLElement>("[data-material-count]")!;
  const more = section.querySelector<HTMLButtonElement>("[data-material-more]")!;
  const select = section.querySelector<HTMLSelectElement>("select")!;
  let source: MemoryMaterialCatalogItem[] = [];
  let cursor: string | null = null;
  let initialized = false;
  let generation = 0;
  const chosen = new Map<string, MemoryMaterialCatalogItem>();
  const drafts = new Map<string, { version: string; anchors: MemoryMaterialAnchor[] }>();
  const citations = (item: MemoryMaterialCatalogItem) => {
    const draft = drafts.get(item.id);
    return draft?.version === item.version ? draft.anchors : [];
  };
  const element = (id: string) =>
    output.querySelector<HTMLElement>('[data-citation-material="' + CSS.escape(id) + '"]');
  const action = (id: "Add" | "Edit" | "Remove", icon: string, attr: string) => `<button type="button"
    class="wb-button memory-citation-action" ${attr} ${messageAttributes("aria-label", `projects.memoryCitation${id}`, {}, t)}
    ${messageAttributes("title", `projects.memoryCitation${id}`, {}, t)}>${codexIcon(icon)}</button>`;
  function show() {
    setMessageHtml(
      output,
      source.length
        ? source
            .map((item) => {
              const selected = chosen.has(item.id);
              const anchors = selected ? citations(item) : [];
              return `<div class="memory-citation-item" data-citation-material="${escapeHtml(item.id)}"><div class="memory-citation-choice">
                <label class="wb-choice"><input type="checkbox" data-memory-material-choice="${escapeHtml(item.id)}" ${selected ? "checked" : ""}>
                <span data-i18n-ignore>${escapeHtml(item.title)}</span></label>
                ${selected && item.citation ? action("Add", "link", "data-citation-add") : ""}
              </div>
              ${
                anchors.length
                  ? `<ul class="memory-citation-drafts">${anchors
                      .map(
                        (anchor, index) =>
                          `<li><span data-i18n-ignore>${escapeHtml(anchor.key)} · ${escapeHtml(anchor.scope)}</span>
                  <small>${escapeHtml(memoryMaterialLocationLabel(t, anchor.location))}</small>
                  ${action("Edit", "pencil", 'data-citation-edit="' + index + '"')}${action("Remove", "x", 'data-citation-remove="' + index + '"')}</li>`,
                      )
                      .join("")}</ul>`
                  : ""
              }</div>`;
            })
            .join("")
        : `<p>${messageHtml("projects.memoryMaterialEmpty", {}, t)}</p>`,
    );
    status.textContent = chosen.size ? t("projects.memoryMaterialCount", { count: chosen.size }) : "";
    more.hidden = cursor === null;
  }
  async function load(append = false) {
    const revision = ++generation;
    initialized = true;
    if (!append) {
      source = [];
      output.textContent = t("common.pageLoading");
    }
    more.disabled = true;
    try {
      const params = new URLSearchParams({ type: select.value });
      if (append && cursor) params.set("cursor", cursor);
      const page = await api<{ items: MemoryMaterialCatalogItem[]; cursor: string | null }>(
        path + "?" + params,
        "GET",
        undefined,
        signal,
      );
      if (signal.aborted || revision !== generation) return;
      source = [...new Map([...source, ...page.items].map((item) => [item.id, item])).values()];
      cursor = page.cursor;
      show();
    } catch (error) {
      if (signal.aborted || revision !== generation) return;
      output.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      more.hidden = false;
    } finally {
      if (!signal.aborted && revision === generation) more.disabled = false;
    }
  }
  output.onchange = (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const input = event.target;
    const item = source.find((entry) => entry.id === input.dataset.memoryMaterialChoice);
    if (!item) return;
    if (input.checked && chosen.size >= 128) {
      input.checked = false;
      status.textContent = t("projects.memoryMaterialLimit");
      return;
    }
    if (input.checked) chosen.set(item.id, item);
    else chosen.delete(item.id);
    show();
    element(item.id)?.querySelector("input")?.focus({ preventScroll: true });
  };
  output.onclick = (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLButtonElement>(
      "[data-citation-add],[data-citation-edit],[data-citation-remove]",
    );
    if (!trigger) return;
    const item = chosen.get(trigger.closest<HTMLElement>("[data-citation-material]")?.dataset.citationMaterial ?? "");
    if (!item) return;
    const anchors = citations(item);
    const editIndex =
      trigger.dataset.citationEdit === undefined ? anchors.length : Number(trigger.dataset.citationEdit);
    function save(values: MemoryMaterialAnchor[]) {
      drafts.set(item!.id, { version: item!.version, anchors: values });
      show();
      const row = element(item!.id);
      return (
        row?.querySelector<HTMLElement>('[data-citation-edit="' + editIndex + '"]') ??
        row?.querySelector<HTMLElement>("[data-citation-add]") ??
        null
      );
    }
    if (trigger.dataset.citationRemove !== undefined) {
      const next = save(anchors.filter((_, index) => index !== Number(trigger.dataset.citationRemove)));
      next?.focus({ preventScroll: true });
      return;
    }
    if (editIndex === anchors.length && anchors.length >= memoryMaterialAnchorLimit) {
      status.textContent = t("projects.memoryCitationLimit");
      return;
    }
    edit(trigger, item, anchors[editIndex], (anchor) => {
      const next = anchors.slice();
      next[editIndex] = anchor;
      return save([...new Map(next.map((row) => [JSON.stringify(row), row])).values()]);
    });
  };
  section.ontoggle = () => {
    if (section.open && !initialized) void load();
  };
  select.onchange = () => {
    cursor = null;
    void load();
  };
  more.onclick = () => {
    void load(cursor !== null);
  };
  return (): MemoryMaterialExportSelection[] =>
    [...chosen.values()].map((item) => {
      const { id, version, kind } = item;
      const anchors = citations(item);
      return { id, version, kind, ...(anchors.length ? { anchors } : {}) };
    });
}

export function memoryMaterialLocationLabel(t: Translate, location: MemoryMaterialAnchor["location"]) {
  if (location.kind === "image") return t("projects.memoryMaterialRegion", location);
  const labels = {
    page: "projects.memoryMaterialPage",
    slide: "projects.memoryMaterialSlide",
    paragraph: "projects.memoryMaterialParagraph",
  } as const;
  return t(labels[location.kind], { number: location.number });
}

export interface PackageMaterialContext {
  path: string;
  packageId: string;
  reference?: { key: string; scope: string };
  destination?: { project: string; copies?: Record<string, MemoryMaterialNativeCopy> };
}

function openNativeCopy(project: string, copy: MemoryMaterialNativeCopy, t: Translate) {
  const url =
    copy.kind === "document"
      ? "/documents?" + new URLSearchParams({ project, document: copy.id })
      : "/project?" + new URLSearchParams({ id: project, asset: copy.id });
  return `<a class="wb-button" href="${escapeHtml(url)}" data-memory-native-open
    ${messageAttributes("aria-label", "projects.memoryNativeCopyOpen", {}, t)}
    ${messageAttributes("data-tooltip", "projects.memoryNativeCopyOpen", {}, t)}>${codexIcon("arrowUpRight")}<span class="memory-toolbar-label">${messageHtml("projects.memoryNativeCopyOpen", {}, t)}</span></a>`;
}

export function bindMemoryNativeCopies(
  list: HTMLElement,
  project: string,
  path: string,
  t: Translate,
  signal: AbortSignal,
) {
  const api = harnessApi(t);
  list.addEventListener(
    "click",
    async (event) => {
      const pressed =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-memory-native-copy]") : null;
      if (!pressed || pressed.getAttribute("aria-disabled") === "true" || signal.aborted) return;
      const { package: packageId, material: materialId } = pressed.dataset;
      if (!packageId || !materialId) return;
      const control = pressed.parentElement!;
      const status = control.parentElement!.querySelector<HTMLElement>("[data-memory-native-status]")!;
      pressed.focus({ preventScroll: true });
      pressed.setAttribute("aria-disabled", "true");
      status.textContent = t("projects.memoryNativeCopySaving");
      try {
        const copy = await api<MemoryMaterialNativeCopy>(
          path + "memory-material-copy",
          "POST",
          { packageId, materialId },
          signal,
        );
        if (signal.aborted || !pressed.isConnected) return;
        const returnFocus = pressed === pressed.ownerDocument.activeElement;
        status.classList.add("sr-only");
        status.textContent = t("projects.memoryNativeCopySaved");
        setMessageHtml(control, openNativeCopy(project, copy, t));
        if (returnFocus) control.querySelector("a")?.focus({ preventScroll: true });
      } catch (error) {
        if (!signal.aborted)
          status.textContent = error instanceof Error ? error.message : t("projects.memoryNativeCopyUnavailable");
      } finally {
        pressed.removeAttribute("aria-disabled");
      }
    },
    { signal },
  );
}

export function memoryMaterialList(t: Translate, materials: MemoryPackageMaterial[], context?: PackageMaterialContext) {
  if (!materials.length) return "";
  const references = (material: MemoryPackageMaterial) =>
    (material.anchors ?? [])
      .map((anchor, index) => ({ anchor, index }))
      .filter(
        ({ anchor }) =>
          !context?.reference || (anchor.key === context.reference.key && anchor.scope === context.reference.scope),
      );
  const narrowed = context?.reference ? materials.filter((material) => references(material).length) : [];
  const button = (attrs: string, name: string) =>
    `<button type="button" class="memory-material-link" ${attrs} data-i18n-ignore>${escapeHtml(name)}</button>`;
  return `<section class="memory-package-materials">
    <h3>${messageHtml("projects.memoryMaterialTitle", {}, t)}</h3>
    ${context?.reference && !narrowed.length ? `<p>${messageHtml("projects.memoryMaterialNoLocation", {}, t)}</p>` : ""}
    <ul>${(narrowed.length ? narrowed : materials)
      .map((item) => {
        const label = item.kind === "document" ? "projects.memoryMaterialDocuments" : creativeKindMessages[item.kind];
        const attributes = context
          ? `data-package="${escapeHtml(context.packageId)}" data-material="${escapeHtml(item.id)}"`
          : "";
        const target = context?.destination,
          copy = target?.copies?.[item.id];
        return `<li><div class="memory-material-heading"><div><strong data-i18n-ignore>${escapeHtml(item.title)}</strong> <span>${messageHtml(label, {}, t)}</span></div>
        ${
          target
            ? `<div class="memory-material-copy-action">${
                copy
                  ? openNativeCopy(target.project, copy, t)
                  : `<button type="button" class="wb-button" data-memory-native-copy ${attributes}
          ${messageAttributes("aria-label", "projects.memoryNativeCopyAction", {}, t)}
          ${messageAttributes("data-tooltip", "projects.memoryNativeCopyAction", {}, t)}>${codexIcon("copy")}<span class="memory-toolbar-label">${messageHtml("projects.memoryNativeCopyAction", {}, t)}</span></button>`
              }</div>
          <span role="status" data-memory-native-status></span>`
            : ""
        }
        </div>
        <ul>${memoryMaterialOriginals(item)
          .map((file, index) => {
            if (!context) return `<li data-i18n-ignore>${escapeHtml(file.name)}</li>`;
            const urls = memoryMaterialUrls(context.path, context.packageId, item.id, file);
            const preview = memoryMaterialPreview(item.kind, file.name).kind !== "download";
            const original = `href="${escapeHtml(urls.original)}" download`;
            if (!preview) return `<li><a ${original} data-i18n-ignore>${escapeHtml(file.name)}</a></li>`;
            return `<li class="memory-material-file">${button(attributes + ' data-memory-material-file="' + index + '"', file.name)}
              <a class="wb-button" ${original} ${messageAttributes("aria-label", "creative.assetDownload", {}, t)} ${messageAttributes("title", "creative.assetDownload", {}, t)}>${codexIcon("download")}<span class="sr-only" data-i18n-ignore>${escapeHtml(file.name)}</span></a></li>`;
          })
          .join("")}</ul>
        ${
          references(item).length
            ? `<ul class="memory-material-references">${references(item)
                .map(({ anchor, index }) => {
                  const { key, scope, location } = anchor;
                  const message = memoryMaterialLocationLabel(t, location);
                  const control =
                    context && memoryMaterialAnchorSupported(item, anchor)
                      ? button(attributes + ' data-memory-material-anchor="' + index + '"', message)
                      : escapeHtml(message);
                  return `<li>${context?.reference ? "" : `<code data-i18n-ignore>${escapeHtml(key)} · ${escapeHtml(scope)}</code> `}${control}</li>`;
                })
                .join("")}</ul>`
            : ""
        }
      </li>`;
      })
      .join("")}</ul></section>`;
}

export function bindMemoryMaterialList(
  list: HTMLElement,
  materials: (packageId: string) => MemoryPackageMaterial[] | undefined,
  read: ReturnType<typeof memoryPackageReader>,
  signal: AbortSignal,
) {
  list.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLButtonElement>(
        "[data-memory-material-file],[data-memory-material-anchor]",
      );
      if (!target || !list.contains(target)) return;
      const { package: packageId, material: id, memoryMaterialFile, memoryMaterialAnchor } = target.dataset;
      if (!packageId) return;
      const material = materials(packageId)?.find((item) => item.id === id);
      if (!material) return;
      const file = memoryMaterialOriginals(material)[Number(memoryMaterialFile ?? 0)];
      const anchor = material.anchors?.[Number(memoryMaterialAnchor)];
      if (file) read(target, packageId, material, file, anchor?.location);
    },
    { signal },
  );
}
