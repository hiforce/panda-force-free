import { setOpaqueText, localizeText } from "../i18n.js";
// Owns image-dialog focus, source lifetime and dismissal.
/** @param {import("./ports.js").FeatureOptions<"$", never, "images">} options */
export function assembleImages({ $ }) {
  let imageViewerReturnFocus = null;
  function releaseImageViewer() {
    $("#imageViewerImage").removeAttribute("src");
    $("#imageViewerDownload").removeAttribute("href");
    $("#imageViewerDownload").hidden = true;
    if (imageViewerReturnFocus?.isConnected) imageViewerReturnFocus.focus();
    imageViewerReturnFocus = null;
  }
  function closeImageViewer() {
    const dialog = $("#imageViewer");
    if (dialog.open) dialog.close();
  }
  function openImageViewer(source, title = "Image", path = "") {
    const dialog = $("#imageViewer"),
      image = $("#imageViewerImage");
    imageViewerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpaqueText($("#imageViewerTitle"), title || "Image");
    setOpaqueText($("#imageViewerPath"), path || title || "");
    $("#imageViewerError").hidden = true;
    image.hidden = false;
    image.alt = title || "";
    image.src = source;
    $("#imageViewerOriginal").href = source;
    const download = $("#imageViewerDownload"),
      url = new URL(source, location.href);
    download.hidden = url.origin !== location.origin || url.pathname !== "/api/images/local";
    if (!download.hidden) {
      url.searchParams.delete("thumbnail");
      url.searchParams.set("download", "1");
      download.href = url.pathname + url.search;
    } else download.removeAttribute("href");
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $("#closeImageViewer").focus());
  }
  function bind() {
    document.addEventListener(
      "error",
      (event) => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || !image.classList.contains("message-image")) return;
        const button = image.closest(".message-image-button");
        if (!(button instanceof HTMLElement)) return;
        const original = button.dataset.imageSrc;
        if (original && image.getAttribute("src") !== original && !image.dataset.originalTried) {
          image.dataset.originalTried = "true";
          image.src = original;
          return;
        }
        image.hidden = true;
        button.dataset.imageFailed = "true";
        if (!button.querySelector(".message-image-unavailable")) {
          const notice = document.createElement("span");
          notice.className = "message-image-unavailable";
          localizeText(notice, "common.imageUnavailable");
          button.append(notice);
        }
      },
      true,
    );
    $("#closeImageViewer").onclick = /** @param {Parameters<typeof closeImageViewer>} args */ (...args) =>
      closeImageViewer(...args);
    $("#imageViewerImage").onload = () => {
      $("#imageViewerImage").hidden = false;
      $("#imageViewerError").hidden = true;
    };
    $("#imageViewerImage").onerror = () => {
      $("#imageViewerImage").hidden = true;
      $("#imageViewerError").hidden = false;
    };
    $("#imageViewer").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeImageViewer();
    });
    $("#imageViewer").addEventListener("close", () => {
      releaseImageViewer();
    });
  }
  return {
    bind,
    openImageViewer,
    closeImageViewer,
  };
}
