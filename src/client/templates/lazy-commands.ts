import { isModuleNetworkError } from "../documents/module-network-error.js";
import type { TemplateCommandRuntime } from "./command-port.js";
import { DocumentRuntimeLoader } from "../documents/runtime-loader.js";
import { prepareDocumentModule } from "../documents/module-transfer.js";
const runtime = new DocumentRuntimeLoader<TemplateCommandRuntime>({
  isTransferFailure: isModuleNetworkError,
  prime: (entry) =>
    prepareDocumentModule(entry ? "/template-settings.bundle.js?retry=1" : "/template-settings.bundle.js"),
  evaluate: (entry) =>
    entry ? import("/template-settings.bundle.js?retry=1") : import("/template-settings.bundle.js"),
});
/** Import and rich preview code loads only on explicit actions. */
export const loadTemplateCommands = () => runtime.load();
