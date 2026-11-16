import { SourceError, type SourceLimits, type SourceEntryPolicy } from "../../../shared/packages/sources/contracts.js";
import { captureSourceSnapshot, type CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { captureLinkedSourceSnapshot } from "../../../shared/packages/sources/linked-capture.js";
import type { SourceStagePurpose, SourceStageRequest } from "../../../shared/packages/stages/contracts.js";
import type { SourceHttpPort } from "../source-http.js";
import { GitHubPackageSources } from "../github/source.js";
import { openZipSource } from "../zip/source.js";

export interface SourceCredentialResolver {
  token(actor: string, purpose: SourceStagePurpose, connectionId: string, signal: AbortSignal): Promise<string | null>;
}
export interface SourceCaptureProvider {
  capture(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    request: SourceStageRequest,
    signal: AbortSignal,
    limits: SourceLimits,
    entryPolicy?: SourceEntryPolicy,
  ): Promise<CapturedPackageSource>;
}
export type SourceOriginalReader = (
  actor: string,
  purpose: SourceStagePurpose,
  id: string,
  signal: AbortSignal,
) => Promise<Uint8Array>;

/** Only explicit owner-bound connections reach provider auth; no environment token or global CLI fallback exists. */
export class PackageSourceProviders implements SourceCaptureProvider {
  constructor(
    private http: SourceHttpPort,
    private original: SourceOriginalReader,
    private credentials?: SourceCredentialResolver,
  ) {}
  async capture(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    request: SourceStageRequest,
    signal: AbortSignal,
    limits: SourceLimits,
    entryPolicy: SourceEntryPolicy = "regular-only/v1",
  ) {
    if (signal.aborted) throw new SourceError("sourceCancelled");
    const source = request.source;
    if (source.kind === "zip-upload") {
      const bytes = await this.original(actor, purpose, id, signal),
        reader = await openZipSource(bytes, source.name, limits, signal, entryPolicy);
      return (entryPolicy === "logical-links/v2" ? captureLinkedSourceSnapshot : captureSourceSnapshot)(
        reader,
        request.selected ?? undefined,
        bytes,
        limits,
        signal,
      );
    }
    const github = new GitHubPackageSources(
        this.http,
        {
          token: (connection, current) =>
            this.credentials?.token(actor, purpose, connection, current ?? signal) ?? Promise.resolve(null),
        },
        limits,
      ),
      snapshot = await github.capture(
        {
          repository: source.repository,
          ...(source.ref === null ? {} : { ref: source.ref }),
          root: source.root,
          ...(source.connectionId === null ? {} : { connectionId: source.connectionId }),
        },
        request.selected ?? undefined,
        signal,
        source.repositoryId ?? undefined,
        entryPolicy,
      );
    return snapshot;
  }
}
