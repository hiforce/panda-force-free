import { isModuleNetworkError } from "../module-network-error.js";
import { DocumentRuntimeLoader } from "../runtime-loader.js";
import { prepareDocumentModule } from "../module-transfer.js";
const reader = new DocumentRuntimeLoader({
  isTransferFailure: isModuleNetworkError,
  prime: (entry) =>
    prepareDocumentModule(entry ? "/document-code-runtime.bundle.js?retry=1" : "/document-code-runtime.bundle.js"),
  evaluate: (entry) =>
    entry ? import("/document-code-runtime.bundle.js?retry=1") : import("/document-code-runtime.bundle.js"),
});
export const loadDocumentCodeReader = () => reader.load();
