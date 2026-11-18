import type { CreationArtifact } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { creativeFileExtension, creativeFilePreview } from "../../shared/creative/file-types.js";
import { escapeHtml as e } from "../../shared/html.js";
import { creativeAssetsApi } from "../creative/assets-api.js";
import { request } from "../http-client.js";
import { setMessageHtml, messageHtml, messageAttributes, localizeText } from "../i18n.js";

/** Receipts render immediately. Only visible image covers transfer bytes; opening uses the protected original viewer. */
export function appendCreationArtifact(host: HTMLElement, artifact: CreationArtifact, t: Translate) {
  const node = document.createElement("section");
  node.className = "creation-artifact";
  const asset = artifact.kind === "document" ? null : artifact,
    image = asset?.kind === "image",
    media = asset ? creativeFilePreview(asset.source.name).kind : "",
    format = asset ? creativeFileExtension(asset.source.name).toUpperCase() : "",
    divisor = asset && asset.source.size >= 1024 * 1024 ? 1024 * 1024 : asset && asset.source.size >= 1024 ? 1024 : 1,
    size = asset
      ? new Intl.NumberFormat(document.documentElement.lang || "en", { maximumFractionDigits: 1 }).format(
          asset.source.size / divisor,
        ) +
        " " +
        (divisor === 1 ? "B" : divisor === 1024 ? "KiB" : "MiB")
      : "";
  setMessageHtml(
    node,
    `<h3 data-i18n-ignore>${artifact.title ? e(artifact.title) : messageHtml("creation.savedFile", {}, t)}</h3>${asset ? `<p class="creation-artifact-file" data-i18n-ignore>${e(asset.source.name)}</p><p class="creation-artifact-meta"><span data-i18n-ignore>${e(format)} · ${e(size)}</span><span data-artifact-dimensions></span></p>` : artifact.kind === "document" && artifact.file ? `<p class="creation-artifact-file" data-i18n-ignore>${e(artifact.file.path.split("/").at(-1) || "")}</p>` : ""}${image ? `<button type="button" class="creation-artifact-preview" data-creation-action="open" ${messageAttributes("aria-label", "creative.assetOpenOriginal", {}, t)}><img alt="${e(artifact.title || "")}" decoding="async" hidden><span data-artifact-loading role="status">${messageHtml("documents.loading", {}, t)}</span></button><p class="creation-artifact-error" role="status" hidden><span>${messageHtml("creation.previewFailed", {}, t)}</span> <button type="button" class="wb-button" data-artifact-retry>${messageHtml("common.retry", {}, t)}</button></p>` : ""}${asset && (media === "video" || media === "audio") ? `<${media} class="creation-artifact-media" hidden controls preload="none" playsinline aria-label="${e(asset.title)}"></${media}><button type="button" class="wb-button" data-artifact-play>${messageHtml("creation.playMedia", {}, t)}</button><p class="creation-artifact-error" data-artifact-media-error role="status" hidden>${messageHtml("creative.assetPreviewFailed", {}, t)} <button type="button" class="wb-button" data-artifact-media-retry>${messageHtml("common.retry", {}, t)}</button></p>` : ""}<div class="creation-artifact-actions"><button type="button" class="wb-button primary" data-creation-action="open">${messageHtml(artifact.kind === "document" ? "creation.openDocument" : image ? "creative.assetOpenOriginal" : "creative.open", {}, t)}</button>${asset ? `<a class="wb-button" href="${e(creativeAssetsApi.content(asset.projectId, asset.assetId, asset.version))}" download>${messageHtml("creative.assetDownload", {}, t)}</a>` : ""}</div>`,
  );
  host.append(node);
  const player = node.querySelector<HTMLMediaElement>(".creation-artifact-media");
  if (player) {
    node.addEventListener("click", (event) => {
      if ((event.target as Element).closest('[data-creation-action="open"]')) player.pause();
    });
    const notice = node.querySelector<HTMLElement>("[data-artifact-media-error]")!,
      play = node.querySelector<HTMLButtonElement>("[data-artifact-play]")!;
    play.onclick = (event) => {
      event.stopPropagation();
      play.hidden = true;
      player.hidden = false;
      player.src = creativeAssetsApi.view(asset!.projectId, asset!.assetId, asset!.version);
      void player.play().catch((cause) => {
        if (cause?.name !== "AbortError") notice.hidden = false;
      });
    };
    player.onerror = () => {
      notice.hidden = false;
    };
    player.onloadedmetadata = () => {
      notice.hidden = true;
    };
    node.querySelector<HTMLButtonElement>("[data-artifact-media-retry]")!.onclick = (event) => {
      event.stopPropagation();
      notice.hidden = true;
      player.load();
      void player.play().catch((cause) => {
        if (cause?.name !== "AbortError") notice.hidden = false;
      });
    };
    return () => {
      player.pause();
      player.onerror = null;
      player.onloadedmetadata = null;
      player.removeAttribute("src");
      player.load();
    };
  }
  if (!image || !asset) return () => {};
  let live = true,
    active: AbortController | null = null,
    objectUrl: string | null = null;
  const img = node.querySelector<HTMLImageElement>("img")!,
    loading = node.querySelector<HTMLElement>("[data-artifact-loading]")!,
    error = node.querySelector<HTMLElement>(".creation-artifact-error")!,
    retry = node.querySelector<HTMLButtonElement>("[data-artifact-retry]")!;
  const failed = () => {
    loading.hidden = true;
    img.hidden = true;
    error.hidden = false;
  };
  img.onload = () => {
    loading.hidden = true;
    img.hidden = false;
  };
  img.onerror = failed;
  const load = async () => {
    if (!live || active) return;
    const controller = new AbortController();
    active = controller;
    retry.disabled = true;
    error.hidden = true;
    loading.hidden = false;
    try {
      const response = await request(
        creativeAssetsApi.view(asset.projectId, asset.assetId, asset.version) + "&variant=cover",
        {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        },
      );
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/webp") {
        await response.body?.cancel();
        throw new Error("Image cover unavailable");
      }
      const blob = await response.blob();
      if (!live || controller.signal.aborted) return;
      if (!blob.size || blob.size > 512 * 1024) throw new Error("Invalid image cover size");
      const width = Number(response.headers.get("x-panda-image-width")),
        height = Number(response.headers.get("x-panda-image-height"));
      if ([width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 40000000))
        localizeText(
          node.querySelector<HTMLElement>("[data-artifact-dimensions]")!,
          "creation.imageDimensions",
          { width: String(width), height: String(height) },
          t,
        );
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
    } catch {
      if (live && !controller.signal.aborted) failed();
    } finally {
      if (active === controller) active = null;
      if (live) retry.disabled = false;
    }
  };
  retry.onclick = (event) => {
    event.stopPropagation();
    void load();
  };
  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer?.disconnect();
              void load();
            }
          },
          { rootMargin: "160px" },
        );
  if (observer) observer.observe(node);
  else void load();
  return () => {
    live = false;
    observer?.disconnect();
    active?.abort();
    img.onload = img.onerror = null;
    img.removeAttribute("src");
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}
