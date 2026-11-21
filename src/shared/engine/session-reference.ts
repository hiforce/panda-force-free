import { harnessId } from "../harness/presentation.js";

/** Accept only the public native or managed conversation reference, never arbitrary namespaces. */
export function validSessionReference(value: unknown): value is string {
  return typeof value === "string" && (/^[a-z0-9_-]{1,128}$/i.test(value) || harnessId(value) !== null);
}
