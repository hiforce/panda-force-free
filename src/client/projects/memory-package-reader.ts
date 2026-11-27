import type { Translate } from "../../shared/i18n/messages.js";
import type {
  MemoryMaterialAnchor,
  MemoryMaterialFile,
  MemoryPackageMaterial,
} from "../../shared/project-memory/materials.js";
import { memoryMaterialPreview, memoryMaterialPreviewTextBytes } from "../../shared/project-memory/materials.js";
import { creativeFileExtension } from "../../shared/creative/file-types.js";
import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { bindPagedPreview, slidePreviewView } from "../creative/slides-preview.js";
import { documentPreview } from "../documents/preview.js";
import { request } from "../http-client.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";

export function memoryMaterialUrls(path: string, packageId: string, materialId: string, file: MemoryMaterialFile) {
  const query = new URLSearchParams({ package: packageId, id: materialId, digest: file.digest, name: file.name });
  return { original: path + "memory-material?" + query, preview: path + "memory-material-preview?" + query };
}

export async function readMemoryMaterialText(
  text: HTMLElement,
  url: string,
  file: Pick<MemoryMaterialFile, "name">,
  kind: MemoryPackageMaterial["kind"],
  signal: AbortSignal,
) {
  const response = await request(url, {
    signal,
    headers: { Range: "bytes=0-" + (memoryMaterialPreviewTextBytes - 1) },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Material preview failed");
  }
  const contents = await response.text();
  signal.throwIfAborted();
  const markdown = kind === "document" || creativeFileExtension(file.name) === "md";
  if (markdown) setMessageHtml(text, documentPreview(contents));
  else {
    const pre = document.createElement("pre");
    pre.textContent = contents;
    text.replaceChildren(pre);
  }
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  return {
    paragraphs:
      markdown || contents.trim() ? Array.from(text.querySelectorAll<HTMLElement>(markdown ? "p" : "pre")) : [],
    truncated: response.status === 206 && total > memoryMaterialPreviewTextBytes,
  };
}

export function memoryRegionStyle(
  element: HTMLElement,
  location: Extract<MemoryMaterialAnchor["location"], { kind: "image" }>,
) {
  element.style.insetInlineStart = location.x * 100 + "%";
  element.style.insetBlockStart = location.y * 100 + "%";
  element.style.width = location.width * 100 + "%";
  element.style.height = location.height * 100 + "%";
}

export function memoryPackageReader(
  dialog: HTMLDialogElement,
  path: string,
  t: Translate,
  signal: AbortSignal,
  dismiss?: () => void,
) {
  let active:
    | { frame: HTMLElement; request: AbortController; trigger: HTMLElement; section: HTMLElement; heading: HTMLElement }
    | undefined;
  const m = (id: Parameters<typeof messageHtml>[0]) => messageHtml(id, {}, t);
  function close() {
    const previous = active;
    if (!previous) return;
    active = undefined;
    previous.request.abort();
    previous.frame.remove();
    previous.section.hidden = false;
    previous.heading.hidden = false;
    dialog.classList.remove("memory-package-reading");
    dialog.setAttribute("aria-labelledby", "memoryPackageTitle");
    if (dismiss) dismiss();
    else previous.trigger.focus({ preventScroll: true });
  }
  dialog.addEventListener(
    "cancel",
    (event) => {
      if (!active) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    },
    { capture: true, signal },
  );

  return (
    trigger: HTMLElement,
    packageId: string,
    material: Pick<MemoryPackageMaterial, "id" | "kind">,
    file: MemoryMaterialFile,
    at?: MemoryMaterialAnchor["location"],
  ) => {
    close();
    const heading = dialog.querySelector<HTMLElement>(":scope > header")!;
    const section = dialog.querySelector<HTMLElement>(":scope > .memory-package-body")!;
    const frame = document.createElement("section");
    frame.className = "memory-material-reader";
    const urls = memoryMaterialUrls(path, packageId, material.id, file);
    setMessageHtml(
      frame,
      `<header>
      <button type="button" class="wb-button" data-memory-material-back ${messageAttributes("aria-label", "common.back", {}, t)} ${messageAttributes("title", "common.back", {}, t)}>${codexIcon("arrowLeft")}</button>
      <h2 id="memoryMaterialTitle" tabindex="-1" title="${escapeHtml(file.name)}" data-i18n-ignore>${escapeHtml(file.name)}</h2>
      <a class="wb-button" href="${escapeHtml(urls.original)}" download ${messageAttributes("aria-label", "creative.assetDownload", {}, t)} ${messageAttributes("title", "creative.assetDownload", {}, t)}>${codexIcon("download")}</a>
    </header><div class="memory-material-reading-body"></div>`,
    );
    section.hidden = heading.hidden = true;
    dialog.classList.add("memory-package-reading");
    dialog.setAttribute("aria-labelledby", "memoryMaterialTitle");
    dialog.append(frame);
    const controller = new AbortController();
    active = { frame, request: controller, trigger, section, heading };
    const current = AbortSignal.any([signal, controller.signal]);
    frame.querySelector<HTMLButtonElement>("button")!.onclick = close;
    frame.querySelector("h2")!.focus({ preventScroll: true });
    const host = frame.querySelector<HTMLElement>(".memory-material-reading-body")!;
    const kind = memoryMaterialPreview(material.kind, file.name).kind;
    const missing = t("projects.memoryMaterialLocationMissing");
    const failed = t("projects.memoryMaterialPreviewFailed");
    if (kind === "slides" || kind === "pdf") {
      const pdf = kind === "pdf";
      const initial = at?.kind === "page" || at?.kind === "slide" ? at.number : 1;
      if (initial > 500) {
        host.textContent = missing;
        return;
      }
      setMessageHtml(host, slidePreviewView(t, "", pdf));
      bindPagedPreview(host, (page) => urls.preview + "&page=" + page, t, current, {
        initial,
        pdf,
        unavailable: failed,
        notFound: missing,
      });
      return;
    }
    if (kind === "text") {
      setMessageHtml(
        host,
        `<p role="status" data-memory-material-status>${m("common.pageLoading")}</p>
        <button type="button" class="wb-button" data-memory-material-retry hidden>${m("common.retry")}</button>
        <article class="markdown-body memory-material-document" data-i18n-ignore></article>`,
      );
      const status = host.querySelector<HTMLElement>("[data-memory-material-status]")!;
      const retry = host.querySelector<HTMLButtonElement>("button")!;
      const text = host.querySelector<HTMLElement>("article")!;
      async function load() {
        retry.hidden = true;
        status.textContent = t("common.pageLoading");
        try {
          const { paragraphs, truncated } = await readMemoryMaterialText(
            text,
            urls.preview,
            file,
            material.kind,
            current,
          );
          status.textContent = truncated ? t("creative.assetPreviewTruncated") : "";
          if (at?.kind === "paragraph") {
            const target = paragraphs[at.number - 1];
            if (!target) status.textContent = missing;
            else {
              target.classList.add("memory-material-target");
              target.setAttribute("tabindex", "-1");
              target.scrollIntoView({ block: "nearest" });
              (target as HTMLElement).focus({ preventScroll: true });
            }
          }
        } catch {
          if (current.aborted) return;
          status.textContent = failed;
          retry.hidden = false;
        }
      }
      retry.onclick = () => void load();
      void load();
      return;
    }
    if (kind === "download") {
      host.textContent = t("creative.assetDownloadOnly");
      return;
    }
    const media = document.createElement(kind === "image" ? "img" : kind);
    media.className = kind === "image" ? "creative-native-image" : "creative-native-media";
    const mediaFrame = document.createElement("div");
    mediaFrame.className = "memory-material-media";
    mediaFrame.append(media);
    host.append(mediaFrame);
    if (media instanceof HTMLImageElement) {
      media.alt = file.name;
      media.decoding = "async";
      if (at?.kind === "image") {
        const region = document.createElement("span");
        region.className = "memory-material-region";
        region.hidden = true;
        region.setAttribute("role", "img");
        region.setAttribute("aria-label", t("projects.memoryMaterialRegion", at));
        memoryRegionStyle(region, at);
        mediaFrame.append(region);
        media.addEventListener(
          "load",
          () => {
            region.hidden = false;
          },
          { signal: current },
        );
      }
    } else {
      media.controls = true;
      media.preload = "metadata";
      if (media instanceof HTMLVideoElement) media.playsInline = true;
    }
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    media.addEventListener(
      "error",
      () => {
        status.textContent = failed;
        host.append(status);
      },
      { signal: current },
    );
    current.addEventListener(
      "abort",
      () => {
        media.removeAttribute("src");
        if (media instanceof HTMLMediaElement) media.load();
      },
      { once: true },
    );
    media.src = urls.preview;
  };
}
