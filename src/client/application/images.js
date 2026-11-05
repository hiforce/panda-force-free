import { setOpaqueText } from "../i18n.js";
// Owns image-dialog focus, source lifetime and dismissal.
export function assembleImages({ $ }) {
  let imageViewerReturnFocus = null;
  function releaseImageViewer() {
    $("#imageViewerImage").removeAttribute("src");
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
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $("#closeImageViewer").focus());
  }
  function bind() {
    $("#closeImageViewer").onclick = (...args) => closeImageViewer(...args);
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
