import { isModuleNetworkError } from "./module-network-error.js";
import { DocumentRuntimeLoader } from "./runtime-loader.js";
import { prepareDocumentModule } from "./module-transfer.js";

const runtime = new DocumentRuntimeLoader({
  isTransferFailure: isModuleNetworkError,
  prime: (entry) =>
    prepareDocumentModule(entry ? "/document-rich-runtime.bundle.js?retry=1" : "/document-rich-runtime.bundle.js"),
  evaluate: (entry) =>
    entry ? import("/document-rich-runtime.bundle.js?retry=1") : import("/document-rich-runtime.bundle.js"),
});
/** Runtime evaluation happens only for editing; failed downloads remain retryable at a stable fallback URL. */
export const loadRichEditor = () => runtime.load();
/** Route preparation downloads without evaluating the editor, and never prevents reading. */
export function warmRichEditor() {
  void runtime.warm().catch(() => {
    // A speculative download error is displayed only if the user subsequently requests editing.
  });
}
