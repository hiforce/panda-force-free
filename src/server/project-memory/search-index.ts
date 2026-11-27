import { randomUUID } from "node:crypto";
import type { MemoryIndexStatus } from "../../shared/project-memory/contracts.js";
import { SEARCH_LIMITS, type SearchDocument } from "../../shared/search/contracts.js";
import type { HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../harness/ports.js";
import { decode } from "../harness/records.js";
import { IndexIntegrityError } from "../search/integrity.js";
import type { IndexReference, SearchCandidate, TextIndexProvider } from "../search/ports.js";
import { digest, namespace } from "./records.js";
import { memorySearchAnalyzer as analyzer } from "./search-documents.js";

type Tier = TextIndexProvider["id"];
type Scope = { owner: string; project: string };
type Resource = { name: string; fingerprint: string; tier: Tier; connection?: string };
type Published = Resource & { revision: number; ref: IndexReference };
type Attempt = Resource & { revision: number; expires: number };

interface IndexState extends Scope {
  revision: number;
  salt: string;
  published?: Published;
  attempt?: Attempt;
  failures: number;
}

export interface MemorySearchProviders {
  local: TextIndexProvider;
  external?: string;
  resolveExternal?(connection: string): Promise<TextIndexProvider>;
}
type SearchResult = { hits: Map<string, string>; available: boolean; salt?: string };
const buildTimeout = 115_000;
const auditInterval = 300_000;
const retirementGrace = 2000;

async function write(
  tx: HarnessMetadataTransaction,
  previous: HarnessRecord | null,
  record: { id: string; kind: string; owner: string },
  state: unknown,
  updatedAt: number,
) {
  await tx.put(
    { ...record, data: JSON.stringify(state), updatedAt, revision: (previous?.revision ?? 0) + 1 },
    previous?.revision ?? null,
  );
}

export class ProjectMemorySearch {
  private readonly tiers: Tier[];
  private readonly working = new Map<Tier, Promise<void>>();
  private readonly stopping = new AbortController();

  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly providers: MemorySearchProviders,
    private readonly snapshot: (owner: string, project: string, salt: string) => Promise<SearchDocument[]>,
    private readonly now: () => number = Date.now,
    private readonly collection: "conventions" | "materials" = "conventions",
  ) {
    this.tiers = providers.external ? ["local", "elasticsearch"] : ["local"];
  }

  private kind(tier: Tier) {
    return (this.collection === "materials" ? "memory-material-index:" : "memory-index:") + tier;
  }

  private retirementKind(tier: Tier) {
    return (this.collection === "materials" ? "memory-material-retire:" : "memory-retire:") + tier;
  }

  private anchor(scope: Scope, tier: Tier) {
    return this.kind(tier) + ":" + namespace(scope.owner, scope.project);
  }

  private async provider(tier: Tier, connection = this.providers.external) {
    const value =
      tier === "local"
        ? this.providers.local
        : connection
          ? await this.providers.resolveExternal?.(connection)
          : undefined;
    if (!value || value.id !== tier) throw new Error("Project memory search provider unavailable");
    return value;
  }

  private async retirement(tx: HarnessMetadataTransaction, bucket: string, resource: Resource) {
    const id = "memory-index-retire:" + resource.name;
    if (!(await tx.get(id)))
      await write(
        tx,
        null,
        { id, kind: this.retirementKind(resource.tier), owner: bucket },
        resource,
        this.now() + retirementGrace,
      );
  }

  async dirty(tx: HarnessMetadataTransaction, owner: string, project: string, createOnly = false) {
    const local = decode<IndexState>(await tx.get(this.anchor({ owner, project }, "local")));
    const salt = local?.salt ?? randomUUID();
    for (const tier of this.tiers) {
      const id = this.anchor({ owner, project }, tier);
      const row = await tx.get(id);
      if (row && createOnly) continue;
      const previous = decode<IndexState>(row);
      const state: IndexState = {
        ...previous,
        owner,
        project,
        salt,
        revision: (previous?.revision ?? 0) + 1,
        failures: 0,
      };
      await write(
        tx,
        row,
        { id, kind: this.kind(tier), owner: namespace(owner, project) },
        state,
        Math.max(this.now(), state.attempt?.expires ?? 0),
      );
    }
  }

  private async removeExternal(row: HarnessRecord) {
    await this.metadata.transaction(async (tx) => {
      if ((await tx.get(row.id))?.revision !== row.revision) return;
      const state = decode<IndexState>(row)!;
      if (state.attempt && state.attempt.expires > this.now()) return;
      if (state.attempt) await this.retirement(tx, row.owner, state.attempt);
      if (state.published) await this.retirement(tx, row.owner, state.published);
      await tx.remove(row.id, row.revision);
    });
  }

  async ensure(owner: string, project: string, rebuild = false) {
    const scope = { owner, project };
    if (!this.providers.external) {
      const old = await this.metadata.read(this.anchor(scope, "elasticsearch"));
      if (old) {
        await this.removeExternal(old);
        this.wake();
      }
    }
    if (
      rebuild ||
      (await Promise.all(this.tiers.map((tier) => this.metadata.read(this.anchor(scope, tier))))).some((row) => !row)
    ) {
      await this.metadata.transaction((tx) => this.dirty(tx, owner, project, !rebuild));
      this.wake();
    }
  }

  wake() {
    if (this.stopping.signal.aborted) return;
    for (const tier of ["local", "elasticsearch"] as const)
      if (!this.working.has(tier))
        this.working.set(
          tier,
          this.process(tier)
            .catch(() => {})
            .finally(() => {
              this.working.delete(tier);
            }),
        );
  }

  async close() {
    this.stopping.abort();
    await Promise.all(this.working.values());
  }

  private async retire(tier: Tier, rows: HarnessRecord[]) {
    for (const row of rows) {
      const resource = decode<Resource>(row)!;
      try {
        const provider = await this.provider(tier, resource.connection);
        if (resource.fingerprint !== provider.fingerprint() && !provider.canRetire?.(resource.fingerprint))
          throw new Error("Previously configured provider unavailable");
        await provider.drop({ name: resource.name, provider: tier }, this.stopping.signal);
        await this.metadata.transaction(async (tx) => {
          if ((await tx.get(row.id))?.revision === row.revision) await tx.remove(row.id, row.revision);
        });
      } catch {
        // Retry asynchronously and let other scopes' deletion requests proceed.
        await this.metadata.transaction(async (tx) => {
          if ((await tx.get(row.id))?.revision === row.revision)
            await write(tx, row, row, resource, this.now() + 30_000);
        });
      }
    }
  }

  private async postpone(row: HarnessRecord) {
    await this.metadata.transaction(async (tx) => {
      if ((await tx.get(row.id))?.revision !== row.revision) return;
      const state = decode<IndexState>(row)!;
      state.failures = Math.min(10, state.failures + 1);
      await write(tx, row, row, state, this.now() + Math.min(60_000, 1000 * 2 ** state.failures));
    });
  }

  private async invalidate(row: HarnessRecord, resource: Published) {
    await this.metadata.transaction(async (tx) => {
      const current = await tx.get(row.id);
      const state = decode<IndexState>(current);
      if (!current || state?.published?.name !== resource.name) return;
      await this.retirement(tx, current.owner, resource);
      await write(
        tx,
        current,
        current,
        { ...state, published: undefined },
        Math.max(this.now(), state.attempt?.expires ?? 0),
      );
    });
  }

  async process(tier: Tier) {
    const [jobs, retired] = await Promise.all([
      this.metadata.list(this.kind(tier), undefined, { limit: 1, oldestFirst: true, updatedThrough: this.now() }),
      this.metadata.list(this.retirementKind(tier), undefined, {
        limit: 4,
        oldestFirst: true,
        updatedThrough: this.now(),
      }),
    ]);
    const [row] = jobs;
    await this.retire(tier, retired);
    if (!row) return;
    if (tier === "elasticsearch" && !this.providers.external) {
      await this.removeExternal(row);
      return;
    }
    let provider: TextIndexProvider;
    try {
      provider = await this.provider(tier);
    } catch {
      await this.postpone(row);
      return;
    }

    const state = decode<IndexState>(row)!;
    const published = state.published;
    if (!state.attempt && published?.revision === state.revision && published.fingerprint === provider.fingerprint()) {
      try {
        await provider.audit(
          published.ref,
          analyzer,
          AbortSignal.any([this.stopping.signal, AbortSignal.timeout(8000)]),
        );
        await this.metadata.transaction(async (tx) => {
          if ((await tx.get(row.id))?.revision === row.revision)
            await write(tx, row, row, { ...state, failures: 0 }, this.now() + auditInterval);
        });
      } catch (error) {
        if (error instanceof IndexIntegrityError) await this.invalidate(row, published);
        else await this.postpone(row);
      }
    } else if (!state.attempt || state.attempt.expires <= this.now()) {
      await this.rebuild(row, state, provider);
    }
  }

  private async rebuild(row: HarnessRecord, state: IndexState, provider: TextIndexProvider) {
    const attempt: Attempt = {
      tier: provider.id,
      revision: state.revision,
      expires: this.now() + buildTimeout + 30_000,
      name: digest([row.owner, provider.id, randomUUID()]),
      fingerprint: provider.fingerprint(),
      ...(provider.id === "elasticsearch" ? { connection: this.providers.external } : {}),
    };
    const claimed = await this.metadata.transaction(async (tx) => {
      if ((await tx.get(row.id))?.revision !== row.revision) return false;
      if (state.attempt) await this.retirement(tx, row.owner, state.attempt);
      await write(tx, row, row, { ...state, attempt }, attempt.expires);
      return true;
    });
    if (!claimed) return;
    let ref: IndexReference | undefined;
    try {
      const documents = await this.snapshot(state.owner, state.project, state.salt);
      if (documents.length > SEARCH_LIMITS.documents) throw new Error("Project memory index document limit");
      const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(buildTimeout)]);
      const candidate = await provider.build(attempt.name, documents, analyzer, signal);
      if (candidate.name !== attempt.name || candidate.provider !== provider.id || !candidate.integrity)
        throw new IndexIntegrityError("unverified");
      if (provider.id === "local") await provider.audit(candidate, analyzer, signal);
      ref = candidate;
    } catch {
      // A previously verified generation can still supply opaque candidates checked against SQL.
    }
    await this.metadata.transaction(async (tx) => {
      const current = await tx.get(row.id);
      const latest = decode<IndexState>(current);
      if (!current || latest?.attempt?.name !== attempt.name) {
        await this.retirement(tx, row.owner, attempt);
        return;
      }
      const currentAttempt = latest.revision === attempt.revision && attempt.expires > this.now();
      const active = ref && currentAttempt ? { ...attempt, ref } : undefined;
      if (active && latest.published) await this.retirement(tx, row.owner, latest.published);
      if (!active) await this.retirement(tx, row.owner, attempt);
      const failures = currentAttempt && !active ? Math.min(10, latest.failures + 1) : 0;
      const next: IndexState = {
        ...latest,
        attempt: undefined,
        failures,
        published: active ?? latest.published,
      };
      await write(
        tx,
        current,
        current,
        next,
        this.now() + (active ? auditInterval : failures ? Math.min(60_000, 1000 * 2 ** failures) : 0),
      );
    });
  }

  private async candidates(
    row: HarnessRecord | null,
    index: Published | undefined,
    query: string,
    signal: AbortSignal,
  ): Promise<SearchCandidate[] | null> {
    if (!row || !index || signal.aborted) return null;
    try {
      const provider = await this.provider(index.tier);
      if (provider.fingerprint() !== index.fingerprint) {
        await this.invalidate(row, index);
        this.wake();
        return null;
      }
      return (await provider.query(index.ref, query, analyzer, 96, signal, { match: "any" })).filter(
        ({ id, version }) => /^[a-f0-9]{64}$/u.test(id) && /^[a-f0-9]{64}$/u.test(version),
      );
    } catch (error) {
      if (error instanceof IndexIntegrityError) {
        await this.invalidate(row, index);
        this.wake();
      } else if (index.tier === "elasticsearch" && row.updatedAt > this.now() + 60_000) {
        await this.postpone(row);
      }
      return null;
    }
  }

  async lookup(owner: string, project: string, text: string, waitMs = 500): Promise<SearchResult> {
    await this.ensure(owner, project);
    const scope = { owner, project };
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(waitMs)]);
    const row = await this.metadata.read(this.anchor(scope, "local"));
    const local = decode<IndexState>(row);
    const scopedHits = await this.candidates(row, local?.published, text.slice(0, 800), signal);
    if (!scopedHits || !local) return { hits: new Map(), available: false };
    const salt = local.salt;
    const hits = new Map(scopedHits.map(({ id, version }) => [id, version]));
    if (!this.providers.external || !hits.size) return { hits, available: true, salt };
    if (local?.published?.revision !== local?.revision) return { hits: new Map(), available: false };

    // External providers receive known, authorized projection terms, never a user's raw prompt or search string.
    const approvedTerms = [...new Set(scopedHits.map(({ title }) => title))].join(" ").slice(0, 800);
    const externalRow = await this.metadata.read(this.anchor(scope, "elasticsearch"));
    const external = decode<IndexState>(externalRow);
    const remote = approvedTerms
      ? await this.candidates(externalRow, external?.published, approvedTerms, signal)
      : null;
    if (remote)
      return {
        hits: new Map(
          remote.filter(({ id, version }) => hits.get(id) === version).map(({ id, version }) => [id, version]),
        ),
        available: true,
        salt,
      };
    return { hits, available: true, salt };
  }

  async status(owner: string, project: string): Promise<MemoryIndexStatus> {
    await this.ensure(owner, project);
    const scope = { owner, project };
    const bucket = namespace(owner, project);
    const [local, external, ...retired] = await Promise.all([
      this.metadata.read(this.anchor(scope, "local")).then((row) => decode<IndexState>(row)),
      this.metadata.read(this.anchor(scope, "elasticsearch")).then((row) => decode<IndexState>(row)),
      ...(["local", "elasticsearch"] as const).map((tier) =>
        this.metadata.list(this.retirementKind(tier), bucket, { limit: 1 }),
      ),
    ]);
    const ready = (state: IndexState | null) =>
      !!state && state.published?.revision === state.revision && !state.failures;
    const configured = !!this.providers.external;
    const fallback = configured && !ready(external) && ready(local);
    const selected = fallback || !configured || !ready(local) ? local : external;
    return {
      backend: configured && !fallback && selected === external ? "elasticsearch" : "local",
      state: ready(selected) ? "ready" : selected?.failures ? "unavailable" : "pending",
      fallback,
      cleanupPending:
        retired.some((rows) => rows.length > 0) ||
        (!configured && !!external) ||
        [local, external].some((state) => !!state?.published && state.published.revision !== state.revision),
    };
  }
}
