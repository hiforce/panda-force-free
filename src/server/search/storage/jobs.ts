import { SearchJobCatalog } from "./catalog.js";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { SearchError, type SearchScope, type SearchSettings } from "../../../shared/search/contracts.js";
import { DEFAULT_SEARCH_SETTINGS, searchSettings } from "../../../shared/search/validation.js";
import type { ActiveSearchIndex, SearchJobRow, SearchLedger, RetiredSearchIndex } from "../state.js";
import { retiredGeneration } from "../references.js";
import { searchScopeKey as scopeKey } from "../scope.js";
import { SearchProjectPolicies } from "./project-policies.js";
import { SearchIndexMetadata } from "./index-metadata.js";
import { decodeSearchIndex } from "../descriptor.js";
import { SearchProgressStore, type BuildUpdate } from "./progress.js";
import { resourceActivationAllowed } from "./resource-references.js";
import { reconcileIndexReferences } from "./reference-reconciliation.js";
export { searchScopeKey as scopeKey } from "../scope.js";
export class SearchJobs implements SearchLedger {
  private policies: SearchProjectPolicies;
  private metadata: SearchIndexMetadata;
  private progressStore: SearchProgressStore;
  private readonly catalog: SearchJobCatalog;
  constructor(
    private db: Database,
    private now = () => Date.now(),
  ) {
    this.policies = new SearchProjectPolicies(db, now);
    this.metadata = new SearchIndexMetadata(db, now);
    this.progressStore = new SearchProgressStore(db, now);
    this.catalog = new SearchJobCatalog(db, this.policies, this.metadata);
  }
  get(scope: SearchScope) {
    if (scope.project !== "personal") this.policies.restore(scope);
    const row = this.byKey(scopeKey(scope));
    if (row && !this.policies.valid(row)) throw new SearchError("configuration", 409);
    return row;
  }
  byKey(key: string) {
    const row = this.db.query<SearchJobRow, [string]>("SELECT * FROM search_scopes WHERE key=?").get(key);
    return row ? this.metadata.recover(row) : null;
  }
  view(row: SearchJobRow | null) {
    const active = row && this.active(row);
    return row
      ? {
          settings: searchSettings(JSON.parse(row.settings)),
          revision: row.revision,
          state: row.state,
          documentCount: row.documentCount,
          failure: row.failure,
          updatedAt: row.updatedAt,
          progress: this.progressStore.view(row),
          ready: !!active && !active.invalidated && active.settingsRevision === row.revision,
        }
      : {
          settings: { ...DEFAULT_SEARCH_SETTINGS },
          revision: 0,
          state: "disabled",
          documentCount: 0,
          failure: null,
          updatedAt: 0,
          progress: null,
          ready: false,
        };
  }
  configure(scope: SearchScope, input: unknown, revision: number) {
    const settings = searchSettings(input);
    return this.db
      .transaction(() => {
        const old = this.get(scope);
        if ((old?.revision ?? 0) !== revision) throw new SearchError("conflict", 409);
        if (!old && this.all().length >= 256) throw new SearchError("limit", 409);
        const key = scopeKey(scope);
        if (scope.project !== "personal") this.policies.configure(scope, settings, revision);
        this.db
          .query(
            `INSERT INTO search_scopes(key,source,owner,project,settings,revision,requested,state,updatedAt) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,settings=excluded.settings,revision=excluded.revision,requested=requested+1,state=excluded.state,token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=excluded.updatedAt`,
          )
          .run(
            key,
            scope.source,
            scope.owner,
            scope.project,
            JSON.stringify(settings),
            revision + 1,
            1,
            settings.enabled ? "queued" : "disabled",
            this.now(),
          );
        return this.byKey(key)!;
      })
      .immediate();
  }
  all = () => this.catalog.all();
  hasReadyIndex = (source: string, revision: number) => this.catalog.hasReadyIndex(source, revision);
  wake(key: string, force = false) {
    this.db
      .query(
        "UPDATE search_scopes SET requested=requested+1,state='queued',token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=? WHERE key=? AND state!='disabled'" +
          (force ? " AND state!='needsReview'" : " AND state NOT IN ('queued','running','needsReview')"),
      )
      .run(this.now(), key);
  }
  /** An explicit rebuild fences running work and prevents reuse of the physical generation being replaced. */
  invalidate(key: string, expected?: Pick<SearchJobRow, "active" | "revision" | "requested">) {
    return this.db
      .transaction(() => {
        const row = this.byKey(key);
        if (
          !row ||
          row.state === "disabled" ||
          (expected &&
            (row.active !== expected.active ||
              row.revision !== expected.revision ||
              row.requested !== expected.requested))
        )
          return false;
        const active = this.active(row);
        this.db
          .query("UPDATE search_scopes SET active=? WHERE key=?")
          .run(active ? JSON.stringify({ ...active, invalidated: true }) : null, key);
        this.wake(key, true);
        return true;
      })
      .immediate();
  }
  /** Repeated administrator clicks join the pending full rebuild instead of fencing it again. */
  rebuild(scope: SearchScope) {
    return this.db
      .transaction(() => {
        const row = this.get(scope);
        if (!row) throw new SearchError("notFound", 404);
        if (!this.settings(row).enabled || row.state === "needsReview") throw new SearchError("notReady", 409);
        const active = this.active(row);
        if (["queued", "running"].includes(row.state) && (!active || active.invalidated)) return row;
        this.invalidate(row.key, row);
        return this.byKey(row.key)!;
      })
      .immediate();
  }
  signal(project: string, owner?: string) {
    for (const row of this.all())
      if (
        row.project === project &&
        (project !== "personal" || !owner || row.owner === owner) &&
        row.state !== "disabled"
      )
        this.wake(row.key);
  }
  claim(sources?: readonly string[]) {
    if (sources && !sources.length) return null;
    return this.db
      .transaction(() => {
        const candidate = this.all().find(
          (row) =>
            (row.state === "queued" || (row.state === "running" && (row.leaseUntil ?? Infinity) < this.now())) &&
            (!sources || sources.includes(row.source)),
        );
        if (!candidate) return null;
        const row = this.metadata.recover(candidate);
        if (row.state !== "queued" && row.state !== "running") return null;
        const token = randomUUID();
        this.db
          .query("UPDATE search_scopes SET state='running',token=?,leaseUntil=?,attempts=attempts+1 WHERE key=?")
          .run(token, this.now() + 120000, row.key);
        const claimed = this.byKey(row.key)!;
        this.progressStore.start(claimed);
        return claimed;
      })
      .immediate();
  }
  heartbeat(row: SearchJobRow) {
    return (
      this.db
        .query(
          "UPDATE search_scopes SET leaseUntil=? WHERE key=? AND token=? AND requested=? AND state='running' AND leaseUntil>?",
        )
        .run(this.now() + 120000, row.key, row.token, row.requested, this.now()).changes === 1
    );
  }
  complete(row: SearchJobRow, active: ActiveSearchIndex, commit: string, count: number) {
    return this.db
      .transaction(() => {
        const descriptor = JSON.stringify(active),
          decoded = decodeSearchIndex(descriptor, row.source);
        if (!decoded) throw new SearchError("configuration", 409);
        if (decoded.vector && !resourceActivationAllowed(this.db, decoded.vector)) return false;
        const previous = this.byKey(row.key),
          valid = previous && this.policies.valid(previous) && previous.settings === row.settings;
        if (!valid) return false;
        const updated =
          this.db
            .query(
              "UPDATE search_scopes SET active=?,commitId=?,documentCount=?,state='ready',failure=NULL,token=NULL,leaseUntil=NULL,updatedAt=? WHERE key=? AND token=? AND requested=? AND revision=? AND state='running' AND leaseUntil>?",
            )
            .run(descriptor, commit, count, this.now(), row.key, row.token, row.requested, row.revision, this.now())
            .changes === 1;
        if (updated && previous?.active && previous.active !== descriptor) {
          const retired = retiredGeneration(this.active(previous)!, decoded);
          if (retired)
            this.db
              .query("INSERT INTO search_retired(descriptor,due) VALUES(?,?)")
              .run(JSON.stringify(retired), this.now() + 300000);
        }
        if (updated) this.progressStore.finish(row, "ready");
        return updated;
      })
      .immediate();
  }
  retired(after = 0) {
    return this.db
      .query<RetiredSearchIndex, [number, number]>(
        "SELECT id,descriptor FROM search_retired WHERE id>? AND due<=? ORDER BY id LIMIT 32",
      )
      .all(after, this.now());
  }
  forget(id: number) {
    this.db.query("DELETE FROM search_retired WHERE id=?").run(id);
  }
  fail(row: SearchJobRow, error: string) {
    this.db
      .transaction(() => {
        const updated = this.db
          .query(
            "UPDATE search_scopes SET state=?,failure=?,token=NULL,leaseUntil=NULL,updatedAt=? WHERE key=? AND token=? AND requested=?",
          )
          .run(row.attempts < 3 ? "queued" : "failed", error, this.now(), row.key, row.token, row.requested);
        if (updated.changes) this.progressStore.finish(row, "failed");
      })
      .immediate();
  }
  progress(row: SearchJobRow, value: BuildUpdate) {
    return this.progressStore.update(row, value);
  }
  active(row: SearchJobRow): ActiveSearchIndex | null {
    return row.active === null ? null : decodeSearchIndex(row.active, row.source);
  }
  referencesUncertain() {
    return this.metadata.referencesUncertain();
  }
  reconcileReferences() {
    if (!this.metadata.referencesUncertain()) return false;
    this.all();
    return reconcileIndexReferences(this.db, this.now);
  }
  settings(row: SearchJobRow): SearchSettings {
    return searchSettings(JSON.parse(row.settings));
  }
}
