import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { GadgetRegistry } from "./registry.js";

/** Trusted deployment input only. Browser requests and gadget manifests cannot select host modules. */
export async function registerDeploymentGadgets(path: string, registry: GadgetRegistry) {
  if (!isAbsolute(path)) throw Error("invalidGadgetModulePath");
  const loaded = await import(pathToFileURL(path).href);
  if (typeof loaded.registerGadgets !== "function") throw Error("invalidGadgetModule");
  await loaded.registerGadgets(registry);
}
