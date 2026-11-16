import type { MetadataStore } from "../knowledge/metadata-ports.js";
import type { SearchRuntime } from "./ports.js";
import type { SearchLedger } from "./state.js";
import { indexReferenceInUse } from "./references.js";
import { decodeSearchIndex } from "./descriptor.js";
/** A fair bounded pass retains unknown namespaces and never deletes a currently referenced component. */
export async function retireSearchGenerations(
  ledger: MetadataStore<SearchLedger>,
  runtime: Pick<MetadataStore<SearchRuntime>, "text" | "vectors">,
  after: number,
  report: (error: unknown) => void,
) {
  if (await ledger.referencesUncertain?.()) return 0;
  const batch = await ledger.retired(after);
  for (const item of batch) {
    try {
      const old = decodeSearchIndex(item.descriptor);
      if (!old) continue;
      if (old.text && !(await indexReferenceInUse(ledger, "text", old.text))) {
        const text = await runtime.text(old.source);
        if (text.fingerprint() !== old.textFingerprint && !text.canRetire?.(old.textFingerprint ?? "")) continue;
        await text.drop(old.text);
      }
      if (old.vector && !(await indexReferenceInUse(ledger, "vector", old.vector))) {
        const vectors = await runtime.vectors(old.source);
        if (!vectors || (vectors.fingerprint() !== old.embedding && !vectors.canRetire?.(old.embedding ?? "")))
          continue;
        await vectors.drop(old.vector);
      }
      if (!(await ledger.referencesUncertain?.())) await ledger.forget(item.id);
    } catch (error) {
      report(error);
    }
  }
  return batch.at(-1)?.id ?? 0;
}
