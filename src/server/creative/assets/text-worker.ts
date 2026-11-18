import { parentPort, workerData } from "node:worker_threads";
import { CREATIVE_ASSET_KINDS } from "../../../shared/creative/assets.js";
import { DocumentError } from "../../documents/errors.js";
import { creativeText } from "./text.js";
import { staticCreativePreview } from "./preview.js";

if (!parentPort) throw Error("An authored text worker requires a parent");
try {
  const { kind, name, bytes, preview, resources = [] } = workerData;
  if (!CREATIVE_ASSET_KINDS.includes(kind) || typeof name !== "string" || !(bytes instanceof Uint8Array))
    throw new DocumentError("invalidInput");
  const value = await creativeText(kind, name, bytes);
  if (preview && kind === "web") value.previewHtml = staticCreativePreview(bytes, name, resources);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code: error instanceof DocumentError && error.code === "tooLarge" ? "tooLarge" : "invalidInput",
  });
} finally {
  parentPort.close();
}
