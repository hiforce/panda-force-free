import { isModuleNetworkError } from "../documents/module-network-error.js";
import { DocumentRuntimeLoader } from "../documents/runtime-loader.js";

const runtime = new DocumentRuntimeLoader<typeof import("./details-runtime.js")>({
  prime: async () => {},
  isTransferFailure: isModuleNetworkError,
  evaluate: (entry) => (entry ? import("/template-details.bundle.js?retry=1") : import("/template-details.bundle.js")),
});
/** The small read-only adapter module is independent of authoring and import runtimes. */
export const loadTemplateDetails = () => runtime.load();
