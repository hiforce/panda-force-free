import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import type {
  TemplateSourceCandidate,
  TemplateSourceInspection,
  TemplateSourceKind,
} from "../../../shared/templates/sources/contracts.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { TemplateSourceReader } from "./ports.js";
import { TemplateSourceIndex, sourceRootEligible } from "./index.js";
import { standardSourceProbes, type TemplateSourceProbe } from "./probes.js";

/** Recognition combines independent format probes; installation and build compatibility remain separate authorities. */
export async function discoverTemplateSource(
  source: CapturedPackageSource,
  probes: readonly TemplateSourceProbe[] = standardSourceProbes,
  importableKinds: readonly TemplateSourceKind[] = [],
): Promise<TemplateSourceInspection> {
  const index = new TemplateSourceIndex(source),
    candidates = new Map<string, TemplateSourceCandidate>();
  for (const probe of probes)
    for (const candidate of probe(index)) {
      if (!sourceRootEligible(candidate.root)) continue;
      const key =
          candidate.kind + ":" + candidate.root + (candidate.location ? ":" + JSON.stringify(candidate.location) : ""),
        prior = candidates.get(key);
      if (candidates.size >= 256 && !prior) throw new SourceError("sourceTooLarge");
      candidates.set(key, {
        ...candidate,
        evidence: [...new Set([...(prior?.evidence ?? []), ...candidate.evidence])].sort(),
      });
    }
  return {
    source: source.descriptor,
    sourceDigest: source.digest,
    importableKinds: [...importableKinds],
    candidates: [...candidates.values()].sort(
      (a, b) => a.root.localeCompare(b.root, "en") || a.kind.localeCompare(b.kind, "en"),
    ),
    issues: index.issues,
  };
}
export class TemplateSourceDiscovery {
  constructor(
    private sources: TemplateSourceReader,
    private probes: readonly TemplateSourceProbe[] = standardSourceProbes,
    private importableKinds: readonly TemplateSourceKind[] = [],
  ) {}
  inspect(actor: string, id: string) {
    return this.sources.project(actor, id, (source) =>
      discoverTemplateSource(source, this.probes, this.importableKinds),
    );
  }
}
