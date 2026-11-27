import { parentPort, workerData } from "node:worker_threads";
import { MaterialTextError } from "./contracts.js";
if (!parentPort) throw Error("A material parser requires a parent");
Object.defineProperty(globalThis, "fetch", {
  value: async () => {
    throw new MaterialTextError("unreadable");
  },
  writable: false,
  configurable: false,
});
try {
  const { name, bytes } = workerData;
  if (typeof name !== "string" || !(bytes instanceof Uint8Array)) throw new MaterialTextError("unreadable");
  const { extractMaterialSections } = await import("./extractor.js");
  const value = await extractMaterialSections(name, bytes);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error instanceof MaterialTextError ? error.code : "unreadable" });
} finally {
  parentPort.close();
}
