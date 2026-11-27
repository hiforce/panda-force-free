import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import {
  memoryMaterialCitationId,
  validMemoryMaterialAnchor,
  validMemoryMaterialLocation,
  type MemoryMaterialAnchor,
  type MemoryMaterialCatalogItem,
  type MemoryMaterialCitation,
} from "../../shared/project-memory/materials.js";
import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { bindPagedPreview, slidePreviewView } from "../creative/slides-preview.js";
import { harnessApi } from "../harness/api.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { memoryRegionStyle, readMemoryMaterialText } from "./memory-package-reader.js";

type ImageRegion = Extract<MemoryMaterialAnchor["location"], { kind: "image" }>;
const fullRegion: ImageRegion = { kind: "image", x: 0, y: 0, width: 1, height: 1 };

function bindImageRegion(
  host: HTMLElement,
  url: string,
  item: MemoryMaterialCatalogItem,
  initial: ImageRegion,
  t: Translate,
  signal: AbortSignal,
  update: (region: ImageRegion | null) => void,
) {
  const coordinates = ["x", "y", "width", "height"] as const;
  const labels = [
    "projects.memoryCitationLeft",
    "projects.memoryCitationTop",
    "projects.memoryCitationWidth",
    "projects.memoryCitationHeight",
  ] as const;
  setMessageHtml(
    host,
    `<p class="wb-help">${messageHtml("projects.memoryCitationDraw", {}, t)}</p>
    <div class="memory-material-media memory-citation-image"><img class="creative-native-image"><span class="memory-material-region" hidden></span></div>
    <p role="status" data-citation-image-status>${messageHtml("common.pageLoading", {}, t)}</p>
    <button type="button" class="wb-button" data-citation-image-retry hidden>${messageHtml("common.retry", {}, t)}</button>
    <fieldset class="memory-citation-coordinates" disabled>${coordinates
      .map(
        (key, index) =>
          `<label class="wb-field"><span>${messageHtml(labels[index]!, {}, t)}</span><input type="number" min="${index > 1 ? 1 : 0}" max="100" step="1" data-region-coordinate="${key}" inputmode="numeric"></label>`,
      )
      .join("")}</fieldset>`,
  );
  const image = host.querySelector<HTMLImageElement>("img")!;
  const box = host.querySelector<HTMLElement>(".memory-material-region")!;
  const status = host.querySelector<HTMLElement>("[data-citation-image-status]")!;
  const retry = host.querySelector<HTMLButtonElement>("button")!;
  const fields = host.querySelector<HTMLFieldSetElement>("fieldset")!;
  const inputs = coordinates.map((key) => fields.querySelector<HTMLInputElement>(`[data-region-coordinate="${key}"]`)!);
  image.alt = item.title;
  image.draggable = false;
  let loaded = false;
  let start: { pointer: number; x: number; y: number; before: ImageRegion | null } | undefined;
  function edit() {
    const [x, y, width, height] = inputs.map((input) => input.valueAsNumber / 100) as [number, number, number, number];
    const region: ImageRegion = { kind: "image", x, y, width, height };
    const valid = loaded && validMemoryMaterialLocation(region);
    box.hidden = !valid;
    if (valid) memoryRegionStyle(box, region);
    update(valid ? region : null);
    return valid ? region : null;
  }
  function fill(region: ImageRegion) {
    inputs.forEach((input, index) => {
      input.value = String(Math.round(region[coordinates[index]!] * 100));
    });
    return edit();
  }
  function point(event: PointerEvent) {
    const bounds = image.getBoundingClientRect();
    const clamped = (offset: number, length: number) => Math.min(100, Math.max(0, Math.round((100 * offset) / length)));
    return {
      x: clamped(event.clientX - bounds.left, bounds.width),
      y: clamped(event.clientY - bounds.top, bounds.height),
    };
  }
  const move = (event: PointerEvent) => {
    if (!start || start.pointer !== event.pointerId) return;
    const end = point(event);
    return fill({
      kind: "image",
      x: Math.min(start.x, end.x) / 100,
      y: Math.min(start.y, end.y) / 100,
      width: Math.abs(start.x - end.x) / 100,
      height: Math.abs(start.y - end.y) / 100,
    });
  };
  image.addEventListener(
    "pointerdown",
    (event) => {
      if (!loaded || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      start = { ...point(event), pointer: event.pointerId, before: edit() };
      image.setPointerCapture(event.pointerId);
      update(null);
    },
    { signal },
  );
  image.addEventListener("pointermove", move, { signal });
  image.addEventListener(
    "pointerup",
    (event) => {
      if (!start || start.pointer !== event.pointerId) return;
      const chosen = move(event);
      if (!chosen && start.before) fill(start.before);
      start = undefined;
    },
    { signal },
  );
  image.addEventListener(
    "pointercancel",
    () => {
      if (start?.before) fill(start.before);
      start = undefined;
    },
    { signal },
  );
  fields.addEventListener("input", edit, { signal });
  image.addEventListener(
    "load",
    () => {
      if (signal.aborted) return;
      status.textContent = "";
      loaded = true;
      fields.disabled = false;
      fill(initial);
    },
    { signal },
  );
  image.addEventListener(
    "error",
    () => {
      if (signal.aborted) return;
      status.textContent = t("projects.memoryMaterialPreviewFailed");
      retry.hidden = false;
      update(null);
    },
    { signal },
  );
  signal.addEventListener("abort", () => image.removeAttribute("src"), { once: true });
  retry.onclick = () => {
    status.textContent = t("common.pageLoading");
    retry.hidden = true;
    image.removeAttribute("src");
    image.src = url;
  };
  image.src = url;
}

export function memoryCitationEditor(dialog: HTMLDialogElement, apiPath: string, t: Translate, signal: AbortSignal) {
  let destroy: (() => void) | undefined;
  const api = harnessApi(t);
  const m = (id: MessageId) => messageHtml(id, {}, t);
  dialog.addEventListener(
    "cancel",
    (event) => {
      if (!destroy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      destroy();
    },
    { capture: true, signal },
  );

  return (
    trigger: HTMLElement,
    item: MemoryMaterialCatalogItem,
    previous: MemoryMaterialAnchor | undefined,
    commit: (anchor: MemoryMaterialAnchor) => HTMLElement | null,
  ) => {
    destroy?.();
    const format = item.citation;
    if (!format) return;
    const oldHeading = dialog.querySelector<HTMLElement>(":scope > header")!;
    const oldBody = dialog.querySelector<HTMLElement>(":scope > .memory-package-body")!;
    const section = document.createElement("section");
    section.className = "memory-material-reader memory-citation-editor";
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    function close(returnTo: HTMLElement | null = trigger) {
      destroy = undefined;
      controller.abort();
      section.remove();
      oldBody.hidden = oldHeading.hidden = false;
      dialog.classList.remove("memory-package-reading");
      dialog.setAttribute("aria-labelledby", "memoryPackageTitle");
      returnTo?.focus({ preventScroll: true });
    }
    destroy = close;
    setMessageHtml(
      section,
      `<header>
      <button type="button" class="wb-button" data-citation-back ${messageAttributes("aria-label", "common.back", {}, t)} ${messageAttributes("title", "common.back", {}, t)}>${codexIcon("arrowLeft")}</button>
      <h2 id="memoryCitationTitle" tabindex="-1" title="${escapeHtml(item.source)}" data-i18n-ignore>${escapeHtml(item.source)}</h2>
      <button type="button" class="wb-button primary memory-citation-save" disabled data-citation-save ${messageAttributes("aria-label", "common.save", {}, t)} ${messageAttributes("title", "common.save", {}, t)}>${codexIcon("check")}<span class="memory-citation-save-label">${m("common.save")}</span></button>
    </header>
    <form class="wb-form">
      <label class="wb-field memory-citation-convention"><span>${m("projects.memoryCitationConvention")}</span><select disabled data-citation-reference></select></label>
      <div class="memory-citation-status"><p role="status" data-citation-status>${m("common.pageLoading")}</p><button type="button" class="wb-button" data-citation-retry hidden>${m("common.retry")}</button></div>
      <div class="memory-material-reading-body" data-citation-preview></div>
    </form>`,
    );
    oldBody.hidden = oldHeading.hidden = true;
    dialog.classList.add("memory-package-reading");
    dialog.setAttribute("aria-labelledby", "memoryCitationTitle");
    dialog.append(section);
    section.querySelector("h2")!.focus({ preventScroll: true });
    const form = section.querySelector<HTMLFormElement>("form")!;
    const selection = form.querySelector<HTMLSelectElement>("select")!;
    const save = section.querySelector<HTMLButtonElement>("[data-citation-save]")!;
    const status = form.querySelector<HTMLElement>("[data-citation-status]")!;
    const retry = form.querySelector<HTMLButtonElement>("[data-citation-retry]")!;
    const preview = form.querySelector<HTMLElement>("[data-citation-preview]")!;
    const url =
      apiPath + "memory-export-preview?" + new URLSearchParams({ id: item.id, version: item.version, kind: item.kind });
    const at = previous?.location;
    let location: MemoryMaterialAnchor["location"] | null = null;
    function refresh() {
      save.disabled = selection.disabled || !selection.value || !location;
    }
    function position(value: MemoryMaterialAnchor["location"] | null) {
      location = value;
      refresh();
    }
    async function references() {
      status.textContent = t("common.pageLoading");
      retry.hidden = true;
      try {
        const result = await api<{ references: MemoryMaterialCitation[] }>(
          apiPath + "memory-export",
          "GET",
          undefined,
          active,
        );
        if (active.aborted) return;
        selection.replaceChildren(
          new Option(t("projects.memoryCitationChoose"), ""),
          ...result.references.map(
            ({ key, scope }) => new Option(key + " · " + scope, memoryMaterialCitationId({ key, scope })),
          ),
        );
        const existing = previous && memoryMaterialCitationId(previous);
        if (existing) selection.value = existing;
        else if (result.references.length === 1) selection.selectedIndex = 1;
        selection.disabled = !result.references.length;
        status.textContent = result.references.length ? "" : t("projects.memoryCitationEmpty");
      } catch (error) {
        if (active.aborted) return;
        status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
        retry.hidden = false;
      }
      refresh();
    }
    selection.onchange = refresh;
    retry.onclick = () => void references();
    section.querySelector<HTMLButtonElement>("[data-citation-back]")!.onclick = () => close();
    function saveCitation() {
      if (save.disabled || !location || !form.reportValidity()) return;
      const [key, scope] = JSON.parse(selection.value) as [string, string];
      const anchor = { key, scope, location };
      if (validMemoryMaterialAnchor(anchor)) close(commit(anchor));
    }
    save.onclick = saveCitation;
    form.onsubmit = (event) => {
      event.preventDefault();
      saveCitation();
    };
    void references();
    if (format === "page" || format === "slide") {
      const pdf = format === "page";
      setMessageHtml(preview, slidePreviewView(t, "", pdf, true));
      bindPagedPreview(preview, (number) => url + "&page=" + number, t, active, {
        pdf,
        initial: at?.kind === format ? at.number : 1,
        unavailable: t("projects.memoryMaterialPreviewFailed"),
        onPage: (number) => position(number === null ? null : { kind: format, number }),
      });
      return;
    }
    if (format === "image") {
      bindImageRegion(preview, url, item, at?.kind === "image" ? at : fullRegion, t, active, position);
      return;
    }
    setMessageHtml(
      preview,
      `<label class="wb-field memory-citation-convention"><span>${m("projects.memoryCitationParagraph")}</span><select data-citation-paragraph disabled></select></label>
      <p role="status">${m("common.pageLoading")}</p><button type="button" class="wb-button" hidden>${m("common.retry")}</button>
      <article class="markdown-body memory-material-document" data-i18n-ignore></article>`,
    );
    const text = preview.querySelector<HTMLElement>("article")!;
    const paragraph = preview.querySelector<HTMLSelectElement>("select")!;
    const textStatus = preview.querySelector<HTMLElement>("p")!;
    const retryText = preview.querySelector<HTMLButtonElement>("button")!;
    async function paragraphs() {
      retryText.hidden = true;
      textStatus.textContent = t("common.pageLoading");
      try {
        const result = await readMemoryMaterialText(text, url, { name: item.source }, item.kind, active);
        if (active.aborted) return;
        paragraph.replaceChildren(
          ...result.paragraphs.map((element, index) => {
            const summary = element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 80);
            const label = t("projects.memoryMaterialParagraph", { number: index + 1 });
            return new Option(summary ? label + " · " + summary : label, String(index + 1));
          }),
        );
        const highlight = (scroll: boolean) => {
          const number = Number(paragraph.value);
          for (const element of result.paragraphs) element.classList.remove("memory-material-target");
          const selected = result.paragraphs[number - 1];
          selected?.classList.add("memory-material-target");
          if (scroll) selected?.scrollIntoView({ block: "nearest" });
          position(selected ? { kind: "paragraph", number } : null);
        };
        paragraph.disabled = !result.paragraphs.length;
        if (at?.kind === "paragraph" && at.number <= result.paragraphs.length) paragraph.value = String(at.number);
        paragraph.onchange = () => highlight(true);
        highlight(false);
        textStatus.textContent = paragraph.disabled
          ? t("projects.memoryCitationNoParagraph")
          : result.truncated
            ? t("creative.assetPreviewTruncated")
            : "";
      } catch {
        if (active.aborted) return;
        textStatus.textContent = t("projects.memoryMaterialPreviewFailed");
        retryText.hidden = false;
      }
    }
    retryText.onclick = () => void paragraphs();
    void paragraphs();
  };
}
