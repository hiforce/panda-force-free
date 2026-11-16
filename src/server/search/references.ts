import type { MetadataStore } from "../knowledge/metadata-ports.js";
import type { IndexReference } from "./ports.js";
import type { ActiveSearchIndex, SearchLedger } from "./state.js";
export function sameIndexReference(a: IndexReference | null, b: IndexReference | null) {
  return !!a && !!b && a.provider === b.provider && a.name === b.name;
}
/** Reused components remain active. Only replaced physical resources enter retirement. */
export function retiredGeneration(previous: ActiveSearchIndex, next: ActiveSearchIndex) {
  const retired = {
    ...previous,
    text: sameIndexReference(previous.text, next.text) ? null : previous.text,
    vector: sameIndexReference(previous.vector, next.vector) ? null : previous.vector,
  };
  return retired.text || retired.vector ? retired : null;
}
/** Old queue entries may predate component reuse; current references always take priority over cleanup. */
export async function indexReferenceInUse(
  ledger: MetadataStore<SearchLedger>,
  kind: "text" | "vector",
  ref: IndexReference,
) {
  const rows = await ledger.all();
  if (await ledger.referencesUncertain?.()) return true;
  for (const row of rows) if (sameIndexReference((await ledger.active(row))?.[kind] ?? null, ref)) return true;
  return false;
}
